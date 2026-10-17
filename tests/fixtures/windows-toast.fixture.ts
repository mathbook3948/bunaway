import { CFunction, dlopen, type Pointer, ptr, read } from "bun:ffi";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parentPort, Worker, workerData } from "node:worker_threads";
import { notificationShowSchema } from "#plugins/notification/src/contract";
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
import { createWindowsToastDriver } from "#plugins/notification/src/platforms/windows-toasts";
import { createNotificationShortcut } from "./windows-notification-shortcut.ts";

assert.equal(process.platform, "win32");
const PIXEL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
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
} else {
  const appId = `test.${crypto.randomUUID()}`;
  const removeShortcut = await createNotificationShortcut(appId);
  let controller: ReturnType<typeof createToastController> | undefined;
  const history = async (timeoutMs: number): Promise<string[]> => {
    const child = Bun.spawn(
      [
        "powershell.exe",
        "-NoProfile",
        "-File",
        fileURLToPath(new URL("./windows-toast-history.ps1", import.meta.url)),
        "-AppId",
        appId,
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
      assertToastMediaFiles(media);
      controller.show(media);
      const shown = await waitHistory((items) => items.length === 1);
      assert(shown[0]?.includes("appLogoOverride"));
      assert(shown[0]?.includes("hero"));
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
      "native Show, escaped XML, replacement, clear and shutdown history passed",
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
