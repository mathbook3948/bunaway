import { dlopen, ptr } from "bun:ffi";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import {
  notificationScheduleSchema,
  notificationShowSchema,
} from "#plugins/notification/src/contract";
import {
  createToastSettler,
  drainToastCleanup,
} from "#plugins/notification/src/platforms/toast-cleanup";
import { createToastController } from "#plugins/notification/src/platforms/toast-controller";
import { createWindowsToastDriver } from "#plugins/notification/src/platforms/windows-toasts";
import { deadline, waitFor } from "./deadlines.ts";
import { createNotificationShortcut } from "./windows-notification-shortcut.ts";

// A schedule belongs to Windows once it is accepted, so a toast scheduled by a process that has already
// exited must still arrive, and one the exited process left behind must still be cancellable. The parent
// owns the Start Menu shortcut and the history; the child only schedules and exits normally.
// Observed on windows-2022: toasts scheduled for an AppUserModelID that had never shown a toast on the
// profile left the schedule at their time without reaching the history, whichever process scheduled
// them (observed for the same process, a live child and an exited child). The parent therefore shows and clears one toast first, like an app that has notified before.
assert.equal(process.platform, "win32");
const GROUP = "bunaway-test";
const DELIVER_ID = "exit-deliver";
const CANCEL_ID = "exit-cancel";
const DELIVER_TITLE = "scheduled after exit deliver";
const CANCEL_TITLE = "scheduled after exit cancel";
/** Extra time on top of the child step deadline, so a slow runner that scales deadlines still schedules before the due time. */
const DELIVERY_MARGIN_MS = 10000;
/** The cancelled toast would be due this long after the delivered one. */
const CANCELLED_GAP_MS = 1000;
/** How long past the cancelled toast's time the history is watched for it. */
const CANCELLED_WATCH_MS = 5000;
const APP_ID_PATTERN = /^test\.[a-f0-9-]{36}$/;

const scheduledToast = (id: string, title: string, deliverAt: number) =>
  notificationScheduleSchema.parse({
    id,
    group: GROUP,
    title,
    silent: true,
    suppressPopup: true,
    deliverAt,
  });
const newController = (appId: string) =>
  createToastController(
    createWindowsToastDriver(appId),
    () => {},
    createToastSettler,
  );
const key = (item: { id: string; group: string }) => `${item.group}/${item.id}`;
const BOTH = [
  `${GROUP}/${CANCEL_ID}`,
  `${GROUP}/${DELIVER_ID}`,
];

if (process.argv[2] === "schedule") {
  const appId = process.argv[3] ?? "";
  const deliverAt = Number(process.argv[4]);
  assert(
    APP_ID_PATTERN.test(appId),
    "Only fixture identities may be scheduled",
  );
  assert(Number.isSafeInteger(deliverAt));
  const shell = dlopen("shell32.dll", {
    SetCurrentProcessExplicitAppUserModelID: {
      args: [
        "ptr",
      ],
      returns: "i32",
    },
  });
  try {
    // The real UI host assigns the app's AppUserModelID before any backend call.
    assert(
      shell.symbols.SetCurrentProcessExplicitAppUserModelID(
        ptr(Buffer.from(`${appId}\0`, "utf16le")),
      ) >= 0,
    );
    const controller = newController(appId);
    try {
      controller.schedule(scheduledToast(DELIVER_ID, DELIVER_TITLE, deliverAt));
      controller.schedule(
        scheduledToast(CANCEL_ID, CANCEL_TITLE, deliverAt + CANCELLED_GAP_MS),
      );
      assert.deepEqual(controller.listScheduled().map(key).sort(), BOTH);
    } finally {
      await drainToastCleanup(() => controller.dispose());
    }
  } finally {
    shell.close();
  }
  console.log("scheduled two toasts and exiting");
} else {
  const appId = `test.${crypto.randomUUID()}`;
  const removeShortcut = await createNotificationShortcut(appId);
  let controller: ReturnType<typeof createToastController> | undefined;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let failure:
    | {
        error: unknown;
      }
    | undefined;
  const history = async (): Promise<string[]> => {
    const probe = Bun.spawn(
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
        timeout: deadline("childStep"),
      },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(probe.stdout).text(),
      new Response(probe.stderr).text(),
      probe.exited,
    ]);
    assert.equal(code, 0, stderr);
    const result: unknown = JSON.parse(stdout);
    assert(
      Array.isArray(result) &&
        result.every((value) => typeof value === "string"),
    );
    return result;
  };
  try {
    const warmup = newController(appId);
    controller = warmup;
    warmup.show(
      notificationShowSchema.parse({
        id: "warmup",
        group: GROUP,
        title: "registers the app with the notification platform",
        silent: true,
        suppressPopup: true,
      }),
    );
    await waitFor(() => warmup.list().length > 0 || undefined, {
      deadline: "childStep",
      what: "the warm-up toast to reach the history",
      intervalMs: 250,
    });
    warmup.clearAll();
    await drainToastCleanup(() => warmup.dispose());
    controller = undefined;
    const deliverAt = Date.now() + deadline("childStep") + DELIVERY_MARGIN_MS;
    child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        fileURLToPath(import.meta.url),
        "schedule",
        appId,
        String(deliverAt),
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
        timeout: deadline("childStep"),
      },
    );
    const [childOut, childErr, childCode] = await Promise.all([
      new Response(child.stdout as ReadableStream).text(),
      new Response(child.stderr as ReadableStream).text(),
      child.exited,
    ]);
    assert.equal(childCode, 0, `${childOut}\n${childErr}`);
    assert(
      Date.now() < deliverAt,
      "The scheduling process must have exited before the toast was due",
    );
    // A new adapter in this process sees what the exited process left with Windows.
    const active = newController(appId);
    controller = active;
    assert.deepEqual(active.listScheduled().map(key).sort(), BOTH);
    assert.equal(
      active.cancelScheduled({
        id: CANCEL_ID,
        group: GROUP,
      }),
      null,
    );
    assert.deepEqual(active.listScheduled().map(key), [
      `${GROUP}/${DELIVER_ID}`,
    ]);
    // Windows delivers at the due time; start the bounded wait only after it.
    await Bun.sleep(Math.max(0, deliverAt - Date.now()));
    await waitFor(
      () =>
        active.list().some((item) => key(item) === `${GROUP}/${DELIVER_ID}`) ||
        undefined,
      {
        deadline: "childStep",
        what: "the toast scheduled by the exited process to be delivered",
        intervalMs: 500,
      },
    );
    assert.deepEqual(active.listScheduled(), []);
    const delivered = await history();
    assert.equal(delivered.length, 1, JSON.stringify(delivered));
    assert(delivered[0]?.includes(DELIVER_TITLE));
    // The cancelled toast would have been due shortly after the delivered one; watch the history for it
    // from the moment both times have passed, so a late delivery cannot hide a cancel that did not work.
    await Bun.sleep(
      Math.max(0, deliverAt + CANCELLED_GAP_MS - Date.now()) +
        CANCELLED_WATCH_MS,
    );
    const settled = await history();
    assert.equal(settled.length, 1, JSON.stringify(settled));
    assert(!settled.some((xml) => xml.includes(CANCEL_TITLE)));
    assert.deepEqual(active.list().map(key), [
      `${GROUP}/${DELIVER_ID}`,
    ]);
    assert.deepEqual(active.listScheduled(), []);
    console.log(
      "scheduled toast after the scheduling process exited was delivered and a cancelled one was not",
    );
  } catch (error) {
    failure = {
      error,
    };
    throw error;
  } finally {
    // The child may still be scheduling when the parent fails, so wait for it before removing schedules.
    child?.kill();
    await child?.exited;
    try {
      // Remove only this test's schedules and history, also when the failure came before an adapter existed.
      const owned = controller ?? newController(appId);
      try {
        owned.cancelScheduled({
          id: DELIVER_ID,
          group: GROUP,
        });
        owned.cancelScheduled({
          id: CANCEL_ID,
          group: GROUP,
        });
        owned.clearAll();
      } finally {
        await drainToastCleanup(() => owned.dispose());
      }
    } catch (cleanupError) {
      // A cleanup failure must not replace the error that ended the test.
      if (!failure) {
        throw cleanupError;
      }
      console.error("scheduled toast cleanup failed", cleanupError);
    } finally {
      await removeShortcut();
    }
  }
}
