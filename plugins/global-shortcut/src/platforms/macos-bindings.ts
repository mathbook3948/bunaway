import { dlopen, JSCallback, ptr } from "bun:ffi";
import { ResourceOwner } from "@bunaway/plugin";
import { LIBSYSTEM, LIBSYSTEM_PATH } from "@bunaway/plugin/darwin";
import { pick } from "@bunaway/plugin/win32";
import { BunawayError } from "@bunaway/protocol";
import type { GlobalShortcut } from "#global-shortcut/contract";

const CARBON_PATH = "/System/Library/Frameworks/Carbon.framework/Carbon";

/** `noErr`. */
const NO_ERROR = 0;
/** `eventNotHandledErr`: the handler declines an event so the next handler can see it. */
const EVENT_NOT_HANDLED = -9874;
/** `eventHotKeyExistsErr`: another registration already owns this key combination. */
export const EVENT_HOT_KEY_EXISTS = -9878;

/** Four-character codes from CarbonEvents.h: `keyb`, `keyd` and `hkid`. */
const EVENT_CLASS_KEYBOARD = 0x6b657962;
const EVENT_PARAM_DIRECT_OBJECT = 0x6b657964;
const TYPE_EVENT_HOT_KEY_ID = 0x686b6964;
const EVENT_HOT_KEY_PRESSED = 5;
const EVENT_HOT_KEY_RELEASED = 6;
/** Signature `BNWY` in every `EventHotKeyID`, so events from other hot keys in the process are ignored. */
const HOT_KEY_SIGNATURE = 0x424e5759;
/** `sizeof(EventHotKeyID)`: a four-character signature followed by a 32-bit identifier. */
const HOT_KEY_ID_BYTES = 8;

/** Carbon modifier masks from Events.h (`cmdKey`, `shiftKey`, `optionKey`, `controlKey`). */
const modifierMasks = {
  Super: 0x0100,
  Shift: 0x0200,
  Alt: 0x0800,
  Control: 0x1000,
} as const;

/**
 * ANSI virtual key codes from Events.h (`kVK_ANSI_*` and friends). They name physical key
 * positions, so a shortcut follows the key's place on the keyboard rather than the letter an
 * input source prints on it. `Insert` and `F21` to `F24` have no Mac key code and are absent.
 */
const keyCodes: Record<string, number> = {
  A: 0,
  S: 1,
  D: 2,
  F: 3,
  H: 4,
  G: 5,
  Z: 6,
  X: 7,
  C: 8,
  V: 9,
  B: 11,
  Q: 12,
  W: 13,
  E: 14,
  R: 15,
  Y: 16,
  T: 17,
  "1": 18,
  "2": 19,
  "3": 20,
  "4": 21,
  "6": 22,
  "5": 23,
  "9": 25,
  "7": 26,
  "8": 28,
  "0": 29,
  O: 31,
  U: 32,
  I: 34,
  P: 35,
  Enter: 36,
  L: 37,
  J: 38,
  K: 40,
  N: 45,
  M: 46,
  Tab: 48,
  Space: 49,
  Backspace: 51,
  Escape: 53,
  F17: 64,
  F18: 79,
  F19: 80,
  F20: 90,
  F5: 96,
  F6: 97,
  F7: 98,
  F3: 99,
  F8: 100,
  F9: 101,
  F11: 103,
  F13: 105,
  F16: 106,
  F14: 107,
  F10: 109,
  F1: 122,
  F2: 120,
  F4: 118,
  F15: 113,
  Home: 115,
  PageUp: 116,
  Delete: 117,
  End: 119,
  PageDown: 121,
  Left: 123,
  Right: 124,
  Down: 125,
  Up: 126,
};

/** Whether the key exists on a Mac keyboard layout, so it can be registered. */
export function isMacosKey(key: string): boolean {
  return Object.hasOwn(keyCodes, key);
}

/** Map a validated shortcut to a Carbon virtual key code and modifier mask. */
export function carbonHotKeyCodes(shortcut: GlobalShortcut): {
  keyCode: number;
  modifiers: number;
} {
  const keyCode = keyCodes[shortcut.key];
  if (keyCode === undefined) {
    throw new BunawayError({
      code: "UNSUPPORTED",
      message: "This key has no equivalent on a Mac keyboard.",
    });
  }
  return {
    keyCode,
    modifiers: shortcut.modifiers.reduce(
      (mask, modifier) => mask | modifierMasks[modifier],
      0,
    ),
  };
}

/** Owns Carbon hot key registrations and the application event handler that reports them. */
export type HotKeyDriver = {
  /** Sets the receiver of press and release events; calls the receiver only on the UI thread. */
  listen(receive: (event: "pressed" | "released", id: number) => void): void;
  /** Returns the OS status; `EVENT_HOT_KEY_EXISTS` means another registration owns the combination. */
  register(id: number, shortcut: GlobalShortcut): number;
  /** Removes one registration. Returns false when the OS refused or the id is unknown. */
  unregister(id: number): boolean;
  dispose(): void;
};

/** Packs an `EventHotKeyID` into the single 64-bit register the C ABI passes it in. */
function packHotKeyId(id: number): bigint {
  return (BigInt(id) << 32n) | BigInt(HOT_KEY_SIGNATURE);
}

/**
 * Install one application-level handler for hot key press and release and return the driver.
 * Carbon calls the handler synchronously inside the host's event pump on Bun's main thread, so
 * the receiver runs without any thread hop.
 */
export function createCarbonHotKeys(): HotKeyDriver {
  const owner = new ResourceOwner("Global shortcut cleanup failed.");
  const system = owner.acquire(
    () => dlopen(LIBSYSTEM_PATH, pick(LIBSYSTEM, "pthread_main_np")),
    (library) => library.close(),
  );
  if (!system.symbols.pthread_main_np()) {
    owner.dispose();
    throw new BunawayError({
      code: "INTERNAL",
      message: "Carbon hot keys require Bun's main thread.",
    });
  }
  const carbon = owner.acquire(
    () =>
      dlopen(CARBON_PATH, {
        GetApplicationEventTarget: {
          args: [],
          returns: "u64",
        },
        InstallEventHandler: {
          args: [
            "u64",
            "ptr",
            "u64",
            "ptr",
            "ptr",
            "ptr",
          ],
          returns: "i32",
        },
        RemoveEventHandler: {
          args: [
            "u64",
          ],
          returns: "i32",
        },
        RegisterEventHotKey: {
          args: [
            "u32",
            "u32",
            "u64",
            "u64",
            "u32",
            "ptr",
          ],
          returns: "i32",
        },
        UnregisterEventHotKey: {
          args: [
            "u64",
          ],
          returns: "i32",
        },
        GetEventKind: {
          args: [
            "ptr",
          ],
          returns: "u32",
        },
        GetEventParameter: {
          args: [
            "ptr",
            "u32",
            "u32",
            "ptr",
            "u64",
            "ptr",
            "ptr",
          ],
          returns: "i32",
        },
      } as const),
    (library) => library.close(),
  );
  const target = carbon.symbols.GetApplicationEventTarget();
  let receive:
    | ((event: "pressed" | "released", id: number) => void)
    | undefined;
  const hotKeyId = new Uint32Array(2);
  const handler = owner.acquire(
    () =>
      new JSCallback(
        (_call, event) => {
          if (!event) {
            return EVENT_NOT_HANDLED;
          }
          const kind = carbon.symbols.GetEventKind(event);
          if (
            kind !== EVENT_HOT_KEY_PRESSED &&
            kind !== EVENT_HOT_KEY_RELEASED
          ) {
            return EVENT_NOT_HANDLED;
          }
          const status = carbon.symbols.GetEventParameter(
            event,
            EVENT_PARAM_DIRECT_OBJECT,
            TYPE_EVENT_HOT_KEY_ID,
            null,
            BigInt(HOT_KEY_ID_BYTES),
            null,
            ptr(hotKeyId),
          );
          if (status !== NO_ERROR || hotKeyId[0] !== HOT_KEY_SIGNATURE) {
            return EVENT_NOT_HANDLED;
          }
          // A throw would unwind through native frames, so the receiver's failure stops here.
          try {
            receive?.(
              kind === EVENT_HOT_KEY_PRESSED ? "pressed" : "released",
              hotKeyId[1] ?? 0,
            );
          } catch (cause) {
            console.error("Global shortcut event handling failed.", cause);
          }
          return NO_ERROR;
        },
        {
          args: [
            "ptr",
            "ptr",
            "ptr",
          ],
          returns: "i32",
        },
      ),
    (callback) => callback.close(),
  );
  // Two EventTypeSpec entries of { eventClass, eventKind }.
  const specs = new Uint32Array([
    EVENT_CLASS_KEYBOARD,
    EVENT_HOT_KEY_PRESSED,
    EVENT_CLASS_KEYBOARD,
    EVENT_HOT_KEY_RELEASED,
  ]);
  const handlerRef = new BigUint64Array(1);
  const installed = carbon.symbols.InstallEventHandler(
    target,
    handler.ptr,
    2n,
    ptr(specs),
    null,
    ptr(handlerRef),
  );
  if (installed !== NO_ERROR) {
    owner.dispose();
    throw new BunawayError({
      code: "INTERNAL",
      message: `Carbon could not install the hot key handler (${installed}).`,
    });
  }
  owner.acquire(
    () => handlerRef[0] ?? 0n,
    (ref) => {
      carbon.symbols.RemoveEventHandler(ref);
    },
  );
  const refs = new Map<number, bigint>();
  const unregister = (id: number): boolean => {
    const ref = refs.get(id);
    if (ref === undefined) {
      return false;
    }
    refs.delete(id);
    return carbon.symbols.UnregisterEventHotKey(ref) === NO_ERROR;
  };
  return {
    listen(next) {
      receive = next;
    },
    register(id, shortcut) {
      const { keyCode, modifiers } = carbonHotKeyCodes(shortcut);
      const ref = new BigUint64Array(1);
      const status = carbon.symbols.RegisterEventHotKey(
        keyCode,
        modifiers,
        packHotKeyId(id),
        target,
        0,
        ptr(ref),
      );
      if (status === NO_ERROR) {
        refs.set(id, ref[0] ?? 0n);
      }
      return status;
    },
    unregister,
    dispose() {
      receive = undefined;
      // Registrations go before the handler and the libraries they were made through.
      const failed = [
        ...refs.keys(),
      ].filter((id) => !unregister(id));
      owner.dispose();
      if (failed.length > 0) {
        throw new BunawayError({
          code: "INTERNAL",
          message: "Some Carbon hot keys could not be unregistered.",
        });
      }
    },
  };
}
