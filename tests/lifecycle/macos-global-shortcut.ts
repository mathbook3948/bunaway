import { dlopen } from "bun:ffi";
import assert from "node:assert/strict";
import { COREFOUNDATION, COREFOUNDATION_PATH } from "@bunaway/plugin/darwin";
import { pick } from "@bunaway/plugin/win32";
import { MacosApplication } from "#native/macos/bun/application";
import type { GlobalShortcut } from "#plugins/global-shortcut/src/contract";
import {
  dispose,
  initialize,
} from "#plugins/global-shortcut/src/platforms/macos";
import {
  createCarbonHotKeys,
  EVENT_HOT_KEY_EXISTS,
} from "#plugins/global-shortcut/src/platforms/macos-bindings";
import { waitFor } from "../fixtures/deadlines.ts";

/**
 * Drives the real Carbon hot key path on macOS: the plugin registers through
 * `RegisterEventHotKey`, the host's own event pump (`MacosApplication`) dispatches the key events,
 * and synthetic keyboard input posted to the session reaches the plugin as pressed and released.
 * A second registration of the same combination must be refused by Carbon itself.
 */
const CORE_GRAPHICS =
  "/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics";
/** `kCGHIDEventTap`: events enter the system as if a keyboard produced them. */
const HID_EVENT_TAP = 0;
/** CGEventFlags for Control, Option and Shift (`kCGEventFlagMask*`). */
const FLAGS = 0x40000 | 0x80000 | 0x20000;
/** kVK_F18: a key with no default binding, so the test cannot trigger anything else. */
const KEY_CODE_F18 = 79;

const shortcut: GlobalShortcut = {
  key: "F18",
  modifiers: [
    "Control",
    "Alt",
    "Shift",
  ],
};

const emitted: {
  event: string;
  payload: unknown;
}[] = [];
let failure: unknown;
const application = new MacosApplication({
  stopping: () => false,
  quitRequested: () => {},
  sessionEnding: () => {},
  reopened: () => {},
  openUrlsRequested: () => {},
  tick: () => {},
  fail: (error) => {
    failure = error;
  },
});
const core = dlopen(COREFOUNDATION_PATH, pick(COREFOUNDATION, "CFRelease"));
const graphics = dlopen(CORE_GRAPHICS, {
  CGEventCreateKeyboardEvent: {
    args: [
      "ptr",
      "u16",
      "bool",
    ],
    returns: "ptr",
  },
  CGEventSetFlags: {
    args: [
      "ptr",
      "u64",
    ],
    returns: "void",
  },
  CGEventPost: {
    args: [
      "u32",
      "ptr",
    ],
    returns: "void",
  },
});

/** Posts one key transition with the shortcut's modifiers held. */
function postKey(down: boolean): void {
  const event = graphics.symbols.CGEventCreateKeyboardEvent(
    null,
    KEY_CODE_F18,
    down,
  );
  assert(event, "CGEventCreateKeyboardEvent returned no event.");
  try {
    graphics.symbols.CGEventSetFlags(event, BigInt(FLAGS));
    graphics.symbols.CGEventPost(HID_EVENT_TAP, event);
  } finally {
    core.symbols.CFRelease(event);
  }
}

/** Waits until the plugin reported `event`, failing with what was seen if the host never does. */
const reported = (event: string) =>
  waitFor(() => emitted.some((entry) => entry.event === event), {
    deadline: "childStep",
    what: `${event} (seen: ${JSON.stringify(emitted)})`,
    failed: () => failure,
  });

const instance = initialize({
  dataRoot: ".",
  capabilities: [],
  events: {
    emit: (event, payload) => {
      emitted.push({
        event,
        payload,
      });
    },
  },
});
try {
  // 1. Carbon itself refuses a second registration of a combination this process already owns.
  instance.register(shortcut);
  const second = createCarbonHotKeys();
  try {
    assert.equal(second.register(9999, shortcut), EVENT_HOT_KEY_EXISTS);
  } finally {
    second.dispose();
  }

  // 2. A press and release reach the plugin through the host's event pump.
  const waiting = instance.waitForPress();
  postKey(true);
  await reported("globalShortcut.pressed");
  assert.deepEqual(await waiting, {
    shortcut,
  });
  postKey(false);
  await reported("globalShortcut.released");
  assert.deepEqual(
    emitted.map((entry) => entry.event),
    [
      "globalShortcut.pressed",
      "globalShortcut.released",
    ],
  );

  // 3. Suspended and removed shortcuts no longer reach the plugin.
  emitted.length = 0;
  instance.setSuspended(true);
  postKey(true);
  postKey(false);
  await Bun.sleep(500);
  assert.deepEqual(emitted, []);
  instance.setSuspended(false);
  assert.equal(instance.unregister(shortcut), true);
  postKey(true);
  postKey(false);
  await Bun.sleep(500);
  assert.deepEqual(emitted, []);
  console.log("macos-global-shortcut: ok");
} finally {
  dispose(instance);
  application.close();
}
