import { dlopen, ptr } from "bun:ffi";
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
 * Drives the real Carbon hot key path on macOS. The plugin registers through
 * `RegisterEventHotKey`, and the host's own event pump (`MacosApplication`) must hand the hot key
 * events to the plugin's application event handler:
 *
 * 1. Carbon itself refuses a second registration of a combination this process owns.
 * 2. Hot key press and release events queued on the main event queue reach the plugin through the
 *    pump, and suspended or removed shortcuts ignore them.
 * 3. Keyboard input posted to the session is tried as well. Posting input needs Accessibility trust
 *    that a hosted runner may not grant, so this step reports whether the OS delivered the hot key
 *    and fails only when it delivered an incomplete pair.
 */
const CARBON = "/System/Library/Frameworks/Carbon.framework/Carbon";
const CORE_GRAPHICS =
  "/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics";
const APPLICATION_SERVICES =
  "/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices";
/** Four-character codes `keyb`, `keyd` and `hkid`, and the `BNWY` signature the plugin registers with. */
const EVENT_CLASS_KEYBOARD = 0x6b657962;
const EVENT_PARAM_DIRECT_OBJECT = 0x6b657964;
const TYPE_EVENT_HOT_KEY_ID = 0x686b6964;
const HOT_KEY_SIGNATURE = 0x424e5759;
const EVENT_HOT_KEY_PRESSED = 5;
const EVENT_HOT_KEY_RELEASED = 6;
/** `kEventPriorityStandard`. */
const EVENT_PRIORITY_STANDARD = 1;
/** The first registration of an adapter gets identifier 1. */
const FIRST_HOT_KEY_ID = 1;
/** The session event taps worth trying, in the order of how close to the keyboard they are. */
const EVENT_TAPS = {
  hid: 0,
  session: 1,
  annotatedSession: 2,
} as const;
/** CGEventFlags for Control, Option and Shift (`kCGEventFlagMask*`). */
const FLAGS = 0x40000 | 0x80000 | 0x20000;
/** kVK_F18: a key with no default binding, so the test cannot trigger anything else. */
const KEY_CODE_F18 = 79;
/** kVK_Control, kVK_Option and kVK_Shift with the CGEventFlags each one sets. */
const MODIFIER_KEYS = [
  [
    59,
    0x40000,
  ],
  [
    58,
    0x80000,
  ],
  [
    56,
    0x20000,
  ],
] as const;
/** How long a quiet period proves that nothing more is coming. */
const QUIET_MS = 500;

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
const carbon = dlopen(CARBON, {
  CreateEvent: {
    args: [
      "ptr",
      "u32",
      "u32",
      "f64",
      "u32",
      "ptr",
    ],
    returns: "i32",
  },
  SetEventParameter: {
    args: [
      "ptr",
      "u32",
      "u32",
      "u64",
      "ptr",
    ],
    returns: "i32",
  },
  GetMainEventQueue: {
    args: [],
    returns: "ptr",
  },
  PostEventToQueue: {
    args: [
      "ptr",
      "ptr",
      "i16",
    ],
    returns: "i32",
  },
  ReleaseEvent: {
    args: [
      "ptr",
    ],
    returns: "void",
  },
});
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
const services = dlopen(APPLICATION_SERVICES, {
  AXIsProcessTrusted: {
    args: [],
    returns: "bool",
  },
});

/** Queues one hot key event for the registration with `id`; the pump delivers it. */
function queueHotKeyEvent(kind: number, id: number): void {
  const created = new BigUint64Array(1);
  assert.equal(
    carbon.symbols.CreateEvent(
      null,
      EVENT_CLASS_KEYBOARD,
      kind,
      0,
      0,
      ptr(created),
    ),
    0,
  );
  const event = created[0] ?? 0n;
  const hotKeyId = new Uint32Array([
    HOT_KEY_SIGNATURE,
    id,
  ]);
  try {
    assert.equal(
      carbon.symbols.SetEventParameter(
        event,
        EVENT_PARAM_DIRECT_OBJECT,
        TYPE_EVENT_HOT_KEY_ID,
        BigInt(hotKeyId.byteLength),
        ptr(hotKeyId),
      ),
      0,
    );
    assert.equal(
      carbon.symbols.PostEventToQueue(
        carbon.symbols.GetMainEventQueue(),
        event,
        EVENT_PRIORITY_STANDARD,
      ),
      0,
    );
  } finally {
    carbon.symbols.ReleaseEvent(event);
  }
}

/** Posts one key transition with `flags` as the modifier state it carries. */
function postKey(
  tap: number,
  keyCode: number,
  down: boolean,
  flags: number,
): void {
  const event = graphics.symbols.CGEventCreateKeyboardEvent(
    null,
    keyCode,
    down,
  );
  assert(event, "CGEventCreateKeyboardEvent returned no event.");
  try {
    graphics.symbols.CGEventSetFlags(event, BigInt(flags));
    graphics.symbols.CGEventPost(tap, event);
  } finally {
    core.symbols.CFRelease(event);
  }
}

/**
 * Types the shortcut the way a keyboard does: each modifier goes down first so the window server
 * tracks the modifier state, then the key, then everything is released in reverse order.
 */
function postShortcut(tap: number, down: boolean): void {
  // `flagsAfter[i]` is the modifier state once the first i + 1 modifiers are down.
  const flagsAfter = MODIFIER_KEYS.map((_key, index) =>
    MODIFIER_KEYS.slice(0, index + 1).reduce(
      (mask, [, flag]) => mask | flag,
      0,
    ),
  );
  if (down) {
    MODIFIER_KEYS.forEach(([keyCode], index) => {
      postKey(tap, keyCode, true, flagsAfter[index] ?? 0);
    });
    postKey(tap, KEY_CODE_F18, true, FLAGS);
    return;
  }
  postKey(tap, KEY_CODE_F18, false, FLAGS);
  for (let index = MODIFIER_KEYS.length - 1; index >= 0; index--) {
    postKey(
      tap,
      MODIFIER_KEYS[index]?.[0] ?? 0,
      false,
      flagsAfter[index - 1] ?? 0,
    );
  }
}

const reported = (event: string, limit: "childStep" | "inProcess") =>
  waitFor(() => emitted.some((entry) => entry.event === event), {
    deadline: limit,
    what: `${event} (seen: ${JSON.stringify(emitted)})`,
    failed: () => failure,
  });
const names = () => emitted.map((entry) => entry.event);

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

  // 2. Queued press and release events reach the plugin through the host's event pump.
  const waiting = instance.waitForPress();
  queueHotKeyEvent(EVENT_HOT_KEY_PRESSED, FIRST_HOT_KEY_ID);
  await reported("globalShortcut.pressed", "childStep");
  assert.deepEqual(await waiting, {
    shortcut,
  });
  queueHotKeyEvent(EVENT_HOT_KEY_RELEASED, FIRST_HOT_KEY_ID);
  await reported("globalShortcut.released", "childStep");
  assert.deepEqual(names(), [
    "globalShortcut.pressed",
    "globalShortcut.released",
  ]);
  // Events for an identifier nobody registered are ignored.
  emitted.length = 0;
  queueHotKeyEvent(EVENT_HOT_KEY_PRESSED, FIRST_HOT_KEY_ID + 100);
  await Bun.sleep(QUIET_MS);
  assert.deepEqual(emitted, []);

  // 3. Suspending releases the registration: a queued event for its retired identifier is dropped.
  instance.setSuspended(true);
  queueHotKeyEvent(EVENT_HOT_KEY_PRESSED, FIRST_HOT_KEY_ID);
  await Bun.sleep(QUIET_MS);
  assert.deepEqual(emitted, []);
  instance.setSuspended(false);
  const resumedId = FIRST_HOT_KEY_ID + 1;
  queueHotKeyEvent(EVENT_HOT_KEY_PRESSED, resumedId);
  await reported("globalShortcut.pressed", "childStep");
  queueHotKeyEvent(EVENT_HOT_KEY_RELEASED, resumedId);
  await reported("globalShortcut.released", "childStep");
  emitted.length = 0;

  // 4. Real keyboard input from the session. Whether a runner lets a process post input depends on
  // Accessibility trust, so the outcome is reported for each tap rather than assumed.
  console.log(
    `macos-global-shortcut: accessibility trusted = ${services.symbols.AXIsProcessTrusted()}`,
  );
  let delivered: string | undefined;
  for (const [name, tap] of Object.entries(EVENT_TAPS)) {
    postShortcut(tap, true);
    const sawPress = await waitFor(
      () => names().includes("globalShortcut.pressed"),
      {
        deadline: "inProcess",
        what: "the OS to deliver the hot key",
        failed: () => failure,
      },
    ).catch(() => {
      // A host pump failure is a test failure; only a missing event means the runner dropped the input.
      if (failure) {
        throw failure;
      }
      return false;
    });
    postShortcut(tap, false);
    if (sawPress) {
      await reported("globalShortcut.released", "childStep");
      delivered = name;
      break;
    }
  }
  console.log(
    `macos-global-shortcut: OS-level key input delivered through ${delivered ?? "no tap"}`,
  );
  if (delivered !== undefined) {
    assert.deepEqual(names(), [
      "globalShortcut.pressed",
      "globalShortcut.released",
    ]);
  }

  // 5. A removed shortcut no longer reaches the plugin.
  emitted.length = 0;
  assert.equal(instance.unregister(shortcut), true);
  queueHotKeyEvent(EVENT_HOT_KEY_PRESSED, resumedId);
  await Bun.sleep(QUIET_MS);
  assert.deepEqual(emitted, []);
  console.log("macos-global-shortcut: ok");
} finally {
  dispose(instance);
  application.close();
}
