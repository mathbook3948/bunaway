import assert from "node:assert/strict";
import { Windows } from "../../native/windows/bun/win32.ts";
import { Tray } from "../../plugins/tray/src/tray.ts";
import { TASKBAR_CREATED, trayCleanup } from "./tray-cleanup-platform.ts";

const windows = new Windows(() => {});
const tray = new Tray(windows, "Cleanup fixture", () => {
  throw new Error("Tray callback delivered after disposal began");
});
tray.setIcon("controlled custom icon");
const icon = trayCleanup.nextIcon - 1n;
trayCleanup.iconFailures.set(icon, 2);
for (let attempt = 1; attempt <= 2; attempt++) {
  assert.throws(
    () => tray.dispose(),
    (error: unknown) => {
      assert(error instanceof AggregateError);
      assert.equal(error.errors.length, 1);
      assert.match(String(error.errors[0]), /Tray icon cleanup failed/);
      return true;
    },
  );
  assert(trayCleanup.icons.has(icon), "Failed icon release lost ownership");
  assert.equal(trayCleanup.windowAttempts, 1);
  assert.equal(trayCleanup.shellAttempts, 1);
  assert.equal(trayCleanup.iconAttempts.length, attempt);
  const notifications = trayCleanup.shellNotifications.length;
  trayCleanup.callback(TASKBAR_CREATED, 0n, 0n);
  trayCleanup.callback(16, 0n, 0n);
  trayCleanup.callback(0x8001, 0n, 0x202n);
  assert.equal(trayCleanup.shellNotifications.length, notifications);
}
tray.dispose();
tray.dispose();
assert.equal(trayCleanup.icons.size, 0);
assert.deepEqual(trayCleanup.iconAttempts, [
  icon,
  icon,
  icon,
]);
assert.equal(trayCleanup.windowAttempts, 1);
assert.equal(trayCleanup.shellAttempts, 1);
windows.dispose();

// Window and DLL failures retain their own release stages without repeating freed icons.
const secondWindows = new Windows(() => {});
const secondTray = new Tray(secondWindows, "Other releases", () => {});
secondTray.setIcon("another controlled icon");
const secondIcon = trayCleanup.nextIcon - 1n;
trayCleanup.windowFailures = 1;
trayCleanup.shellFailures = 1;
assert.throws(
  () => secondTray.dispose(),
  (error: unknown) => {
    assert(error instanceof AggregateError);
    assert.match(String(error.errors[0]), /Injected window release failure/);
    return true;
  },
);
assert.equal(trayCleanup.icons.size, 0);
assert.throws(
  () => secondTray.dispose(),
  (error: unknown) => {
    assert(error instanceof AggregateError);
    assert.match(String(error.errors[0]), /Injected shell release failure/);
    return true;
  },
);
secondTray.dispose();
secondTray.dispose();
assert.deepEqual(trayCleanup.iconAttempts, [
  icon,
  icon,
  icon,
  secondIcon,
]);
assert.equal(trayCleanup.windowAttempts, 3);
assert.equal(trayCleanup.shellAttempts, 3);
secondWindows.dispose();
assert(
  !trayCleanup.iconAttempts.includes(1n),
  "Borrowed app icon was destroyed",
);
const startupWindows = new Windows(() => {});
trayCleanup.addFailures = 1;
trayCleanup.windowFailures = 1;
let retained: import("@bunaway/plugin-api/native").NativeTrayOwner | undefined;
assert.throws(
  () =>
    new Tray(
      startupWindows,
      "Failed registration",
      () => {},
      undefined,
      (owner) => {
        retained = owner;
      },
    ),
  /Tray initialization cleanup failed/,
);
assert(retained, "Partial startup ownership was lost");
retained.dispose();
retained.dispose();
startupWindows.dispose();
console.log("PASS retryable tray cleanup and callback shutdown");
