import { dlopen } from "bun:ffi";
import type { NativeShortcutServices } from "@bunaway/plugin-api/native";
import {
  type GlobalShortcut,
  hotkeyCodes,
  MOD_NOREPEAT,
  WM_HOTKEY,
} from "./contract.ts";
import type { ShortcutDriver } from "./shortcut-adapter.ts";

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
