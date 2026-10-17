import { dlopen } from "bun:ffi";
import type { NativeShortcutServices } from "@bunaway/plugin-api/native";
import type { GlobalShortcut } from "#global-shortcut/contract";
import type { ShortcutDriver } from "#global-shortcut/platforms/windows";
import { RELEASE_POLL_INTERVAL_MS } from "#global-shortcut/release-tracker";
export const WM_HOTKEY = 0x0312;
const WM_TIMER = 0x0113;
const RELEASE_TIMER_ID = 1n;
/** GetAsyncKeyState sets the most significant bit while the key is physically down. */
const KEY_DOWN_BIT = 0x8000;
export const MOD_NOREPEAT = 0x4000;
export const MAX_HOTKEY_ID = 0xbfff;

const modifierFlags = {
  Alt: 1,
  Control: 2,
  Shift: 4,
  Super: 8,
} as const;
const namedKeys = {
  Backspace: 0x08,
  Tab: 0x09,
  Enter: 0x0d,
  Escape: 0x1b,
  Space: 0x20,
  PageUp: 0x21,
  PageDown: 0x22,
  End: 0x23,
  Home: 0x24,
  Left: 0x25,
  Up: 0x26,
  Right: 0x27,
  Down: 0x28,
  Insert: 0x2d,
  Delete: 0x2e,
} as const;
/** Map the validated contract to Win32 modifiers and virtual-key codes. */
export function hotkeyCodes(shortcut: GlobalShortcut): {
  modifiers: number;
  key: number;
} {
  const modifiers = shortcut.modifiers.reduce(
    (flags, modifier) => flags | modifierFlags[modifier],
    0,
  );
  const key =
    shortcut.key.length === 1
      ? shortcut.key.charCodeAt(0)
      : shortcut.key.startsWith("F")
        ? 0x70 + Number(shortcut.key.slice(1)) - 1
        : namedKeys[shortcut.key as keyof typeof namedKeys];
  return {
    modifiers,
    key,
  };
}

/** Owns native hotkey bindings and one lazily-created, invisible host message window. */
export class Win32Shortcuts implements ShortcutDriver {
  private readonly native = dlopen("user32.dll", {
    RegisterHotKey: {
      args: [
        "u64",
        "i32",
        "u32",
        "u32",
      ],
      returns: "i32",
    },
    UnregisterHotKey: {
      args: [
        "u64",
        "i32",
      ],
      returns: "i32",
    },
    SetTimer: {
      args: [
        "u64",
        "u64",
        "u32",
        "ptr",
      ],
      returns: "u64",
    },
    KillTimer: {
      args: [
        "u64",
        "u64",
      ],
      returns: "i32",
    },
    GetAsyncKeyState: {
      args: [
        "i32",
      ],
      returns: "i16",
    },
  });
  private hwnd: bigint | undefined;
  private tick: (() => void) | undefined;
  private readonly ids = new Set<number>();
  private receive: ((id: number, packedKeys: bigint) => void) | undefined;
  private timerActive = false;
  private disposed = false;

  constructor(private readonly services: NativeShortcutServices) {}
  listen(receive: (id: number, packedKeys: bigint) => void) {
    this.receive = receive;
  }

  register(id: number, shortcut: GlobalShortcut): boolean {
    if (this.disposed) {
      throw new Error("Global shortcut driver is disposed.");
    }
    this.hwnd ??= this.services.createWindow((message, wparam, lparam) => {
      if (this.disposed) {
        return;
      }
      if (message === WM_HOTKEY) {
        this.receive?.(Number(wparam), lparam);
      } else if (message === WM_TIMER && wparam === RELEASE_TIMER_ID) {
        this.tick?.();
      }
    });
    const codes = hotkeyCodes(shortcut);
    if (
      !this.native.symbols.RegisterHotKey(
        this.hwnd,
        id,
        codes.modifiers | MOD_NOREPEAT,
        codes.key,
      )
    ) {
      return false;
    }
    this.ids.add(id);
    return true;
  }
  isKeyDown(virtualKey: number): boolean {
    return (
      (this.native.symbols.GetAsyncKeyState(virtualKey) & KEY_DOWN_BIT) !== 0
    );
  }
  /**
   * Starts one WM_TIMER on the hidden window. A busy UI thread delays ticks, so a release is
   * reported late, never lost; the timer's resolution is about one system clock tick (15 ms).
   */
  startPolling(tick: () => void) {
    this.tick = tick;
    if (this.timerActive || !this.hwnd || this.disposed) {
      return;
    }
    if (
      !this.native.symbols.SetTimer(
        this.hwnd,
        RELEASE_TIMER_ID,
        RELEASE_POLL_INTERVAL_MS,
        null,
      )
    ) {
      throw new Error("Global shortcut release timer could not be started.");
    }
    this.timerActive = true;
  }
  stopPolling() {
    if (this.timerActive && this.hwnd) {
      this.native.symbols.KillTimer(this.hwnd, RELEASE_TIMER_ID);
    }
    this.timerActive = false;
  }
  unregister(id: number): boolean {
    if (!this.hwnd || !this.ids.has(id)) {
      return false;
    }
    if (!this.native.symbols.UnregisterHotKey(this.hwnd, id)) {
      return false;
    }
    this.ids.delete(id);
    return true;
  }
  dispose() {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.receive = undefined;
    this.tick = undefined;
    const errors: unknown[] = [];
    try {
      this.stopPolling();
      for (const id of this.ids) {
        try {
          if (!this.unregister(id)) {
            errors.push(new Error("Global shortcut removal failed."));
          }
        } catch (error) {
          errors.push(error);
        }
      }
    } finally {
      try {
        // Destroying the owner releases remaining bindings even when explicit unregister failed.
        if (this.hwnd) {
          this.services.destroyWindow(this.hwnd);
        }
      } catch (error) {
        errors.push(error);
      }
      this.hwnd = undefined;
      this.ids.clear();
      this.native.close();
    }
    if (errors.length) {
      throw new AggregateError(errors, "Global shortcut cleanup failed.");
    }
  }
}
