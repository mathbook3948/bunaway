import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cleanupFailedNotificationShortcutCreation,
  createNotificationShortcutCleanup,
  NotificationShortcutCreationError,
} from "../fixtures/notification-shortcut-cleanup.ts";

test("shortcut cleanup retains ownership through transient sharing locks and removes only its file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bunaway-shortcut-cleanup-"));
  const path = join(directory, "fixture.lnk");
  const neighbor = join(directory, "untouched.lnk");
  await writeFile(path, "owned");
  await writeFile(neighbor, "neighbor");
  const events: string[] = [];
  let attempts = 0;
  const cleanup = createNotificationShortcutCleanup({
    async removeShortcut() {
      attempts++;
      if (attempts <= 2) {
        throw Object.assign(new Error("sharing lock"), {
          code: "EBUSY",
        });
      }
      await rm(path, {
        force: true,
      });
    },
    async wait(milliseconds) {
      expect(milliseconds).toBe(100);
      expect(await readFile(path, "utf8")).toBe("owned");
      expect(events).toEqual([]);
    },
    notifyRemoval: () => {
      events.push("removed");
    },
    closeShell: () => {
      events.push("closed");
    },
  });
  try {
    await cleanup();
    await cleanup();
    expect(attempts).toBe(3);
    expect(await Bun.file(path).exists()).toBe(false);
    expect(await readFile(neighbor, "utf8")).toBe("neighbor");
    expect(events).toEqual([
      "removed",
      "closed",
    ]);
  } finally {
    await rm(directory, {
      recursive: true,
      force: true,
    });
  }
});

test("persistent sharing locks are bounded and a subsequent cleanup still owns release", async () => {
  const error = Object.assign(new Error("still locked"), {
    code: "EBUSY",
  });
  let locked = true;
  let attempts = 0;
  let waits = 0;
  let removed = 0;
  let closed = 0;
  const cleanup = createNotificationShortcutCleanup({
    async removeShortcut() {
      attempts++;
      if (locked) {
        throw error;
      }
    },
    async wait() {
      waits++;
    },
    notifyRemoval: () => {
      removed++;
    },
    closeShell: () => {
      closed++;
    },
  });
  await expect(cleanup()).rejects.toBe(error);
  expect(attempts).toBe(10);
  expect(waits).toBe(9);
  expect(removed).toBe(0);
  expect(closed).toBe(0);
  locked = false;
  await cleanup();
  await cleanup();
  expect(attempts).toBe(11);
  expect(removed).toBe(1);
  expect(closed).toBe(1);
});

test("non-sharing failures are not retried or treated as completed cleanup", async () => {
  const error = Object.assign(new Error("access denied"), {
    code: "EPERM",
  });
  let denied = true;
  let attempts = 0;
  let waits = 0;
  let closed = 0;
  const cleanup = createNotificationShortcutCleanup({
    async removeShortcut() {
      attempts++;
      if (denied) {
        throw error;
      }
    },
    async wait() {
      waits++;
    },
    notifyRemoval() {},
    closeShell: () => {
      closed++;
    },
  });
  await expect(cleanup()).rejects.toBe(error);
  expect(attempts).toBe(1);
  expect(waits).toBe(0);
  expect(closed).toBe(0);
  denied = false;
  await cleanup();
  expect(attempts).toBe(2);
  expect(closed).toBe(1);
});

test("concurrent shortcut cleanup shares deletion and releases the shell once", async () => {
  let finish: (() => void) | undefined;
  const deleted = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let attempts = 0;
  let closed = 0;
  const cleanup = createNotificationShortcutCleanup({
    async removeShortcut() {
      attempts++;
      await deleted;
    },
    notifyRemoval() {},
    closeShell: () => {
      closed++;
    },
  });
  const first = cleanup();
  const second = cleanup();
  expect(first).toBe(second);
  expect(attempts).toBe(1);
  expect(closed).toBe(0);
  finish?.();
  await Promise.all([
    first,
    second,
  ]);
  await cleanup();
  expect(attempts).toBe(1);
  expect(closed).toBe(1);
});

test.each([
  "EBUSY",
  "EPERM",
])(
  "failed shortcut creation exposes cleanup ownership after %s and recovers when deletion succeeds",
  async (code) => {
    const directory = await mkdtemp(
      join(tmpdir(), "bunaway-shortcut-creation-"),
    );
    const path = join(directory, "partial.lnk");
    const neighbor = join(directory, "untouched.lnk");
    await writeFile(path, "partial shortcut");
    await writeFile(neighbor, "neighbor");
    const creationError = new Error("creation failed after saving shortcut");
    const cleanupError = Object.assign(new Error("deletion failed"), {
      code,
    });
    let blocked = true;
    let attempts = 0;
    let waits = 0;
    const events: string[] = [];
    let failure: unknown;
    try {
      // Only the thrown failure escapes this scope, just as when native creation rejects before returning cleanup.
      try {
        const cleanup = createNotificationShortcutCleanup({
          async removeShortcut() {
            attempts++;
            if (blocked) {
              throw cleanupError;
            }
            await rm(path, {
              force: true,
            });
          },
          async wait() {
            waits++;
          },
          notifyRemoval: () => {
            events.push("removed");
          },
          closeShell: () => {
            events.push("closed");
          },
        });
        await cleanupFailedNotificationShortcutCreation(creationError, cleanup);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(NotificationShortcutCreationError);
      if (!(failure instanceof NotificationShortcutCreationError)) {
        throw new Error("Creation failure lost shortcut cleanup ownership.");
      }
      expect(failure.errors).toEqual([
        creationError,
        cleanupError,
      ]);
      expect(attempts).toBe(code === "EBUSY" ? 10 : 1);
      expect(waits).toBe(code === "EBUSY" ? 9 : 0);
      expect(await readFile(path, "utf8")).toBe("partial shortcut");
      expect(events).toEqual([]);
      blocked = false;
      await failure.cleanup();
      await failure.cleanup();
      expect(await Bun.file(path).exists()).toBe(false);
      expect(await readFile(neighbor, "utf8")).toBe("neighbor");
      expect(events).toEqual([
        "removed",
        "closed",
      ]);
      expect(attempts).toBe(code === "EBUSY" ? 11 : 2);
    } finally {
      await rm(directory, {
        recursive: true,
        force: true,
      });
    }
  },
);

test("failed shortcut creation preserves its original error after successful cleanup", async () => {
  const creationError = new Error("creation failed");
  let closed = 0;
  const cleanup = createNotificationShortcutCleanup({
    async removeShortcut() {},
    notifyRemoval() {},
    closeShell() {
      closed++;
    },
  });
  await expect(
    cleanupFailedNotificationShortcutCreation(creationError, cleanup),
  ).rejects.toBe(creationError);
  expect(closed).toBe(1);
});
