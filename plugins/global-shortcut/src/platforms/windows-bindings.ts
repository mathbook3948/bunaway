import { dlopen } from "bun:ffi";
import type { NativeShortcutServices } from "@bunaway/plugin-api/native";
import type { GlobalShortcut } from "#global-shortcut/contract";
import type { ShortcutDriver } from "#global-shortcut/platforms/windows";
export const WM_HOTKEY = 0x0312;
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
  });
  private hwnd: bigint | undefined;
  private readonly ids = new Set<number>();
  private receive: ((id: number, packedKeys: bigint) => void) | undefined;
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
      if (message === WM_HOTKEY && !this.disposed) {
        this.receive?.(Number(wparam), lparam);
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
    const errors: unknown[] = [];
    try {
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
