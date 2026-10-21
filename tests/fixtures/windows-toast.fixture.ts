import { CFunction, dlopen, type Pointer, ptr, read } from "bun:ffi";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parentPort, Worker, workerData } from "node:worker_threads";
import {
  notificationScheduleSchema,
  notificationShowSchema,
} from "#plugins/notification/src/contract";
import {
  ACTIVATED_ARGS_IID,
  ACTIVATED_ARGS2_IID,
  FIRST_METHOD_SLOT,
  MAP_STRING_OBJECT_IID,
  readReply,
} from "#plugins/notification/src/platforms/toast-activation";
import {
  createToastSettler,
  drainToastCleanup,
} from "#plugins/notification/src/platforms/toast-cleanup";
import { createToastController } from "#plugins/notification/src/platforms/toast-controller";
import { assertToastMediaFiles } from "#plugins/notification/src/platforms/toast-media";
import {
  checkToast,
  createToastDelegate,
  createToastRuntime,
  guid,
} from "#plugins/notification/src/platforms/toast-winrt";
import { createNotifications } from "#plugins/notification/src/platforms/windows";
import { createWindowsToastDriver } from "#plugins/notification/src/platforms/windows-toasts";
import { waitFor } from "./deadlines.ts";
import { createNotificationShortcut } from "./windows-notification-shortcut.ts";

assert.equal(process.platform, "win32");
const PIXEL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
/** Far enough ahead that a scheduled toast stays pending for the whole fixture. */
const FAR_DELIVERY_MS = 30 * 60 * 1000;
/** Close enough that Windows delivers the scheduled toast while the fixture waits. */
const NEAR_DELIVERY_MS = 8000;
const CLICK_IID = "ab54de2d-97d9-5528-b6ad-105afe156530";
if (workerData?.toastMarshalWorker) {
  assert(parentPort);
  const ole = dlopen("ole32.dll", {
    CoInitializeEx: {
      args: [
        "ptr",
        "u32",
      ],
      returns: "i32",
    },
    CoUninitialize: {
      args: [],
      returns: "void",
    },
    CoGetInterfaceAndReleaseStream: {
      args: [
        "ptr",
        "ptr",
        "ptr",
      ],
      returns: "i32",
    },
  });
  checkToast(ole.symbols.CoInitializeEx(null, 0), "CoInitializeEx(MTA)");
  parentPort.postMessage("ready");
  parentPort.once("message", async (stream: number) => {
    try {
      const out = new BigUint64Array(1);
      checkToast(
        ole.symbols.CoGetInterfaceAndReleaseStream(
          stream as Pointer,
          ptr(guid(CLICK_IID)),
          ptr(out),
        ),
        "CoGetInterfaceAndReleaseStream",
      );
      assert(out[0]);
      const object = Number(out[0]) as Pointer;
      const invoke = CFunction({
        ptr: read.ptr(read.ptr(object), 3 * 8) as Pointer,
        args: [
          "ptr",
          "ptr",
          "ptr",
        ],
        returns: "i32",
      });
      const release = CFunction({
        ptr: read.ptr(read.ptr(object), 2 * 8) as Pointer,
        args: [
          "ptr",
        ],
        returns: "u32",
      });
      try {
        checkToast(invoke(object, null, null), "Marshaled delegate Invoke");
        // Retain the reference until the STA has demonstrated that early disposal is rejected.
        await new Promise<void>((resolve) =>
          parentPort?.once("message", () => resolve()),
        );
      } finally {
        release(object);
        invoke.close();
        release.close();
      }
      parentPort?.postMessage("done");
    } finally {
      ole.symbols.CoUninitialize();
      ole.close();
      parentPort?.close();
    }
  });
} else if (process.argv[2] === "marshal") {
  const runtime = createToastRuntime();
  const kernel = dlopen("kernel32.dll", {
    GetCurrentThreadId: {
      args: [],
      returns: "u32",
    },
  });
  const thread = kernel.symbols.GetCurrentThreadId();
  let invoked = 0;
  let observedRetainedReference = false;
  const delegate = createToastDelegate(CLICK_IID, () => {
    assert.equal(kernel.symbols.GetCurrentThreadId(), thread);
    invoked++;
  });
  const ole = dlopen("ole32.dll", {
    CoMarshalInterThreadInterfaceInStream: {
      args: [
        "ptr",
        "ptr",
        "ptr",
      ],
      returns: "i32",
    },
  });
  const worker = new Worker(new URL(import.meta.url), {
    workerData: {
      toastMarshalWorker: true,
    },
  });
  let ready = false,
    done = false;
  let failure: unknown;
  worker.on("message", (message) => {
    if (message === "ready") {
      ready = true;
    }
    if (message === "done") {
      done = true;
    }
  });
  worker.on("error", (error) => {
    failure = error;
  });
  const exited = new Promise<number>((resolve) => worker.once("exit", resolve));
  try {
    const deadline = Date.now() + 10000;
    while (!ready) {
      if (failure) {
        throw failure;
      }
      assert(Date.now() < deadline, "Marshal worker startup deadline");
      await Bun.sleep(5);
    }
    const stream = new BigUint64Array(1);
    checkToast(
      ole.symbols.CoMarshalInterThreadInterfaceInStream(
        ptr(guid(CLICK_IID)),
        delegate.pointer,
        ptr(stream),
      ),
      "CoMarshalInterThreadInterfaceInStream",
    );
    assert(stream[0]);
    worker.postMessage(Number(stream[0]));
    await drainToastCleanup(() => {
      if (failure) {
        throw failure;
      }
      if (invoked && !observedRetainedReference) {
        assert.throws(() => delegate.dispose(), {
          code: "BUSY",
        });
        observedRetainedReference = true;
        worker.postMessage("release");
      }
      assert(done, "Marshaled native release is pending");
      assert(observedRetainedReference);
      assert.equal(invoked, 1);
      delegate.dispose();
    });
    assert.equal(await exited, 0);
    console.log("native marshal, STA Invoke and delayed Release passed");
  } finally {
    await worker.terminate();
    ole.close();
    kernel.close();
    runtime.dispose();
  }
} else if (process.argv[2] === "activation") {
  // Activated arguments cannot be produced without a user click, so check each interface the parser
  // depends on against Windows itself: the metadata ids and method order, then a real ValueSet.
  const probe = Bun.spawn(
    [
      "powershell.exe",
      "-NoProfile",
      "-File",
      fileURLToPath(new URL("./windows-toast-activation.ps1", import.meta.url)),
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
      timeout: 60000,
    },
  );
  const [probeOut, probeErr, probeCode] = await Promise.all([
    new Response(probe.stdout).text(),
    new Response(probe.stderr).text(),
    probe.exited,
  ]);
  assert.equal(probeCode, 0, probeErr);
  const metadata = new Map<
    string,
    {
      guid: string;
      methods: string[];
    }
  >(
    (
      JSON.parse(probeOut) as {
        name: string;
        guid: string;
        methods: string[];
      }[]
    ).map((entry) => [
      entry.name,
      entry,
    ]),
  );
  const described = (name: string) => {
    const entry = metadata.get(name);
    assert(entry, `${name} metadata`);
    return entry;
  };
  const expectInterface = (
    name: string,
    iid: string,
    method: string,
    slot: number,
  ) => {
    const entry = described(name);
    assert.equal(entry.guid.toLowerCase(), iid, `${name} IID`);
    assert.equal(FIRST_METHOD_SLOT + entry.methods.indexOf(method), slot);
  };
  expectInterface(
    "IToastActivatedEventArgs",
    ACTIVATED_ARGS_IID,
    "get_Arguments",
    FIRST_METHOD_SLOT,
  );
  expectInterface(
    "IToastActivatedEventArgs2",
    ACTIVATED_ARGS2_IID,
    "get_UserInput",
    FIRST_METHOD_SLOT,
  );
  // IMap<String, Object>: Lookup(6), Size(7), HasKey(8), GetView(9), Insert(10).
  const runtime = createToastRuntime();
  const INSERT_SLOT = 10;
  const PROPERTY_VALUE_STATICS_IID = "629bdbc8-d932-4ff4-96b9-8d96c5c1e858";
  const CREATE_INT32_SLOT = 10;
  const CREATE_STRING_SLOT = 18;
  try {
    const set = runtime.activate("Windows.Foundation.Collections.ValueSet");
    const map = runtime.query(set, MAP_STRING_OBJECT_IID);
    const statics = runtime.factory(
      "Windows.Foundation.PropertyValue",
      PROPERTY_VALUE_STATICS_IID,
    );
    const replaced = new Uint8Array(1);
    const insert = (key: string, create: (out: Pointer) => number) => {
      const value = runtime.object(create, "PropertyValue.Create");
      try {
        runtime.string(key, (name) =>
          checkToast(
            runtime.method(
              map,
              INSERT_SLOT,
              [
                "ptr",
                "ptr",
                "ptr",
              ],
              name,
              value,
              ptr(replaced),
            ),
            "ValueSet.Insert",
          ),
        );
      } finally {
        runtime.release(value);
      }
    };
    try {
      assert.equal(readReply(runtime, set, "reply"), "");
      insert("reply", (out) =>
        runtime.string("안녕 hello", (text) =>
          runtime.method(
            statics,
            CREATE_STRING_SLOT,
            [
              "ptr",
              "ptr",
            ],
            text,
            out,
          ),
        ),
      );
      assert.equal(readReply(runtime, set, "reply"), "안녕 hello");
      insert("reply", (out) =>
        runtime.method(
          statics,
          CREATE_INT32_SLOT,
          [
            "i32",
            "ptr",
          ],
          7,
          out,
        ),
      );
      assert.throws(() => readReply(runtime, set, "reply"), {
        code: "INTERNAL",
      });
      console.log("activation interfaces and ValueSet reply reading passed");
    } finally {
      runtime.release(statics);
      runtime.release(map);
      runtime.release(set);
    }
  } finally {
    runtime.dispose();
  }
} else {
  const appId = `test.${crypto.randomUUID()}`;
  const removeShortcut = await createNotificationShortcut(appId);
  let controller: ReturnType<typeof createToastController> | undefined;
  const history = async (
    timeoutMs: number,
    expiration = false,
  ): Promise<string[]> => {
    const child = Bun.spawn(
      [
        "powershell.exe",
        "-NoProfile",
        "-File",
        fileURLToPath(new URL("./windows-toast-history.ps1", import.meta.url)),
        "-AppId",
        appId,
        ...(expiration
          ? [
              "-Expiration",
            ]
          : []),
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
        timeout: timeoutMs,
      },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    assert.equal(code, 0, stderr);
    const result: unknown = JSON.parse(stdout);
    assert(
      Array.isArray(result) &&
        result.every((value) => typeof value === "string"),
    );
    return result;
  };
  const waitHistory = async (
    expected: (items: string[]) => boolean,
  ): Promise<string[]> => {
    const deadline = Date.now() + 15000;
    let observed: string[] = [];
    do {
      observed = await history(Math.max(1, deadline - Date.now()));
      if (expected(observed)) {
        return observed;
      }
      await Bun.sleep(100);
    } while (Date.now() < deadline);
    assert.fail(
      `Notification history did not settle: ${JSON.stringify(observed)}`,
    );
  };
  try {
    controller = createToastController(
      createWindowsToastDriver(appId),
      () => {},
      createToastSettler,
    );
    const first = notificationShowSchema.parse({
      id: "fixture",
      group: "bunaway-test",
      title: "Bunaway fixture <&🚀",
      body: "Escaped </text> content",
      silent: true,
      suppressPopup: true,
    });
    controller.show(first);
    const initial = await waitHistory((items) => items.length === 1);
    assert.equal(
      initial.length,
      1,
      "Suppressed Show must create exactly one history item",
    );
    assert(initial[0]?.includes("&lt;&amp;🚀"));
    assert(initial[0]?.includes("Escaped &lt;/text&gt; content"));
    controller.show({
      ...first,
      title: "replacement fixture",
    });
    const replaced = await waitHistory(
      (items) =>
        items.length === 1 &&
        Boolean(items[0]?.includes("replacement fixture")),
    );
    assert.equal(replaced.length, 1, "Same tag/group must replace history");
    assert(replaced[0]?.includes("replacement fixture"));
    controller.clear(first);
    assert.equal(
      (await waitHistory((items) => items.length === 0)).length,
      0,
      "Targeted clear must remove history",
    );
    // Windows must accept local icon/hero files and a system sound, with the percent-encoded URI kept in history.
    const mediaDirectory = await mkdtemp(join(tmpdir(), "bunaway toast "));
    try {
      const png = join(mediaDirectory, "pixel é.png");
      await Bun.write(png, Buffer.from(PIXEL_PNG_BASE64, "base64"));
      const media = notificationShowSchema.parse({
        id: "media",
        group: "bunaway-test",
        title: "media fixture",
        icon: png,
        image: png,
        imagePlacement: "hero",
        sound: "Looping.Alarm",
        soundLoop: true,
        suppressPopup: true,
      });
      // The adapter's kernel32 probes must accept a temp-directory file and refuse a missing file and a directory.
      const notifications = createNotifications(appId);
      try {
        assertToastMediaFiles(media, notifications.filesystem);
        assert.throws(
          () =>
            assertToastMediaFiles(
              {
                ...media,
                image: join(mediaDirectory, "missing.png"),
              },
              notifications.filesystem,
            ),
          {
            code: "INVALID_ARGUMENT",
          },
        );
        assert.throws(
          () =>
            assertToastMediaFiles(
              {
                ...media,
                image: mediaDirectory,
              },
              notifications.filesystem,
            ),
          {
            code: "INVALID_ARGUMENT",
          },
        );
      } finally {
        notifications.dispose();
      }
      controller.show(media);
      const shown = await waitHistory((items) => items.length === 1);
      assert(shown[0]?.includes("appLogoOverride"));
      assert(shown[0]?.includes("hero"));
      assert(shown[0]?.includes('duration="long"'));
      assert(shown[0]?.includes('loop="true"'));
      assert(shown[0]?.includes("pixel%20%C3%A9.png"));
      assert(shown[0]?.includes("ms-winsoundevent:Notification.Looping.Alarm"));
      controller.clear(media);
      await waitHistory((items) => items.length === 0);
    } finally {
      await rm(mediaDirectory, {
        recursive: true,
        force: true,
      });
    }
    // timeoutType never must be accepted by Windows as a reminder with the system dismiss button. Whether the popup
    // stays until dismissed needs a user at the desktop, so only the stored toast is checked.
    const reminder = notificationShowSchema.parse({
      id: "reminder",
      group: "bunaway-test",
      title: "reminder fixture",
      suppressPopup: true,
      silent: true,
      timeoutType: "never",
    });
    controller.show(reminder);
    const kept = await waitHistory((items) => items.length === 1);
    assert(kept[0]?.includes('scenario="reminder"'));
    assert(kept[0]?.includes('arguments="dismiss"'));
    assert(kept[0]?.includes('activationType="system"'));
    controller.clear(reminder);
    await waitHistory((items) => items.length === 0);
    // expiresAfterSeconds must land in the stored toast's ExpirationTime, and a replacement without it must drop back to the OS default.
    const expiring = notificationShowSchema.parse({
      id: "expiring",
      group: "bunaway-test",
      title: "expiring fixture",
      suppressPopup: true,
      silent: true,
      expiresAfterSeconds: 600,
    });
    const earliestMs = Date.now() + 600_000 - 120_000;
    const latestMs = Date.now() + 600_000 + 120_000;
    controller.show(expiring);
    await waitHistory((items) => items.length === 1);
    const [expiresAt] = await history(15000, true);
    assert(
      expiresAt,
      "A toast with expiresAfterSeconds must keep an ExpirationTime",
    );
    const expiresAtMs = Date.parse(expiresAt);
    assert(
      expiresAtMs >= earliestMs && expiresAtMs <= latestMs,
      `ExpirationTime ${expiresAt} must be about 600 seconds from now`,
    );
    controller.show({
      ...expiring,
      title: "unexpiring fixture",
      expiresAfterSeconds: null,
    });
    // The new title proves the stored toast is the replacement before its ExpirationTime is read.
    await waitHistory(
      (items) =>
        items.length === 1 && Boolean(items[0]?.includes("unexpiring fixture")),
    );
    // Windows gives a toast without an explicit expiration its default retention (about 3 days), so the replacement
    // must read as far later than the 600 second value it replaced.
    const [replacementExpiresAt] = await history(15000, true);
    assert(replacementExpiresAt);
    assert(
      Date.parse(replacementExpiresAt) > Date.now() + 24 * 60 * 60 * 1000,
      `Replacement ExpirationTime ${replacementExpiresAt} must be the OS default, not the earlier value`,
    );
    controller.clear(expiring);
    await waitHistory((items) => items.length === 0);
    // Buttons and the reply box must be accepted by Windows and survive in the stored toast.
    const interactive = notificationShowSchema.parse({
      id: "actions",
      group: "bunaway-test",
      title: "actions fixture",
      suppressPopup: true,
      silent: true,
      actions: [
        {
          id: "ok",
          label: 'OK "quoted" & <more>',
        },
      ],
      reply: {
        placeholder: "Type here",
        buttonLabel: "Send",
      },
    });
    controller.show(interactive);
    const withActions = await waitHistory((items) => items.length === 1);
    assert(withActions[0]?.includes('id="reply"'));
    assert(withActions[0]?.includes('hint-inputId="reply"'));
    assert(
      withActions[0]?.includes(
        'arguments="bunaway1;bunaway-test;actions;reply"',
      ),
    );
    assert(
      withActions[0]?.includes(
        'arguments="bunaway1;bunaway-test;actions;action:ok"',
      ),
    );
    // A body click comes back as the launch string, which names the same toast.
    assert(withActions[0]?.includes('launch="bunaway1;bunaway-test;actions;"'));
    assert(withActions[0]?.includes("Type here"));
    assert(withActions[0]?.includes("&lt;more&gt;"));
    controller.clear(interactive);
    await waitHistory((items) => items.length === 0);
    // clearAll must remove every item of the app across ids and groups.
    for (const [id, group] of [
      [
        "all-a",
        "bunaway-test",
      ],
      [
        "all-b",
        "bunaway-test",
      ],
      [
        "all-a",
        "bunaway-other",
      ],
    ] as const) {
      controller.show({
        ...first,
        id,
        group,
      });
    }
    assert.equal(
      (await waitHistory((items) => items.length === 3)).length,
      3,
      "Distinct id/group pairs must create separate history items",
    );
    // list returns the identities the OS history holds for this app, whichever process created them.
    const key = (item: { id: string; group: string }) =>
      `${item.group}/${item.id}`;
    assert.deepEqual(controller.list().map(key).sort(), [
      "bunaway-other/all-a",
      "bunaway-test/all-a",
      "bunaway-test/all-b",
    ]);
    // clearGroup removes only the records of that group; an unknown group succeeds without effect.
    assert.equal(controller.clearGroup("bunaway-test"), null);
    assert.deepEqual(controller.list().map(key), [
      "bunaway-other/all-a",
    ]);
    assert.equal(
      (await waitHistory((items) => items.length === 1)).length,
      1,
      "clearGroup must remove every history item of that group",
    );
    assert.equal(controller.clearGroup("bunaway-test"), null);
    assert.equal(controller.clearGroup("bunaway-none"), null);
    assert.deepEqual(controller.list().map(key), [
      "bunaway-other/all-a",
    ]);
    assert.equal(controller.clearAll(), null);
    assert.deepEqual(controller.list(), []);
    assert.equal(
      (await waitHistory((items) => items.length === 0)).length,
      0,
      "clearAll must remove every history item of the app",
    );
    // Scheduling: the OS holds the toast until its delivery time, replaces one with the same identity,
    // lists it with the stored time and drops it on cancel.
    const scheduledToast = (id: string, group: string, deliverAt: number) =>
      notificationScheduleSchema.parse({
        id,
        group,
        title: "scheduled fixture",
        silent: true,
        suppressPopup: true,
        deliverAt,
      });
    const listedSchedule = () =>
      controller?.listScheduled().sort((a, b) => key(a).localeCompare(key(b)));
    const later = Date.now() + FAR_DELIVERY_MS;
    assert.deepEqual(controller.listScheduled(), []);
    controller.schedule(scheduledToast("sched-a", "bunaway-test", later));
    controller.schedule(
      scheduledToast("sched-a", "bunaway-other", later + 1000),
    );
    assert.deepEqual(listedSchedule(), [
      {
        id: "sched-a",
        group: "bunaway-other",
        deliverAt: later + 1000,
      },
      {
        id: "sched-a",
        group: "bunaway-test",
        deliverAt: later,
      },
    ]);
    controller.schedule(
      scheduledToast("sched-a", "bunaway-test", later + 2000),
    );
    assert.deepEqual(
      listedSchedule()?.map((item) => `${key(item)}@${item.deliverAt - later}`),
      [
        "bunaway-other/sched-a@1000",
        "bunaway-test/sched-a@2000",
      ],
      "The same id and group must replace the scheduled toast",
    );
    assert.equal(
      controller.cancelScheduled({
        id: "sched-a",
        group: "bunaway-test",
      }),
      null,
    );
    assert.deepEqual(listedSchedule()?.map(key), [
      "bunaway-other/sched-a",
    ]);
    // Cancelling something that is not scheduled succeeds without effect.
    assert.equal(
      controller.cancelScheduled({
        id: "sched-a",
        group: "bunaway-test",
      }),
      null,
    );
    assert.equal(
      controller.cancelScheduled({
        id: "sched-a",
        group: "bunaway-other",
      }),
      null,
    );
    assert.deepEqual(controller.listScheduled(), []);
    assert.throws(
      () =>
        controller?.schedule(
          scheduledToast("sched-late", "bunaway-test", Date.now() - 1000),
        ),
      {
        code: "INVALID_ARGUMENT",
      },
    );
    // A due toast leaves the schedule and arrives in the notification history under its identity.
    controller.schedule(
      scheduledToast(
        "sched-due",
        "bunaway-test",
        Date.now() + NEAR_DELIVERY_MS,
      ),
    );
    await waitFor(
      () =>
        controller
          ?.list()
          .some((item) => key(item) === "bunaway-test/sched-due") || undefined,
      {
        deadline: "nativeFixture",
        what: "the scheduled toast to be delivered",
        intervalMs: 500,
      },
    );
    assert.deepEqual(controller.listScheduled(), []);
    controller.clear({
      id: "sched-due",
      group: "bunaway-test",
    });
    // A schedule outlives the controller that made it: Windows owns it until delivery or cancel.
    controller.schedule(scheduledToast("sched-keep", "bunaway-test", later));
    await drainToastCleanup(() => controller?.dispose());
    controller = createToastController(
      createWindowsToastDriver(appId),
      () => {},
      createToastSettler,
    );
    assert.deepEqual(controller.listScheduled(), [
      {
        id: "sched-keep",
        group: "bunaway-test",
        deliverAt: later,
      },
    ]);
    controller.cancelScheduled({
      id: "sched-keep",
      group: "bunaway-test",
    });
    assert.deepEqual(controller.listScheduled(), []);
    controller.show({
      ...first,
      id: "shutdown",
    });
    await drainToastCleanup(() => controller?.dispose());
    assert.equal(
      (await waitHistory((items) => items.length === 0)).length,
      0,
      "Disposal must remove session toasts",
    );
    console.log(
      "native Show, escaped XML, replacement, clear, scheduled delivery and shutdown history passed",
    );
  } finally {
    try {
      if (controller) {
        await drainToastCleanup(() => controller?.dispose());
      }
    } finally {
      await removeShortcut();
    }
  }
}
