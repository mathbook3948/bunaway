import { dlopen } from "bun:ffi";
import type { NativeShortcutServices } from "@bunaway/plugin-api/native";
import type { ChangeDriver } from "#clipboard/platforms/windows-changes";

export const WM_CLIPBOARDUPDATE = 0x031d;

/**
 * Owns one hidden host window registered with AddClipboardFormatListener.
 * The window comes from the host's UI-thread window services, so messages arrive on the plugin UI thread.
 */
export class Win32ClipboardListener implements ChangeDriver {
  private readonly native = dlopen("user32.dll", {
    AddClipboardFormatListener: {
      args: [
        "u64",
      ],
      returns: "i32",
    },
    RemoveClipboardFormatListener: {
      args: [
        "u64",
      ],
      returns: "i32",
    },
    GetClipboardSequenceNumber: {
      args: [],
      returns: "u32",
    },
  });
  private hwnd: bigint | undefined;
  private receive: ((sequence: number) => void) | undefined;
  private disposed = false;

  /** Throws after releasing everything it acquired when Windows rejects the listener. */
  constructor(private readonly services: NativeShortcutServices) {
    try {
      this.hwnd = services.createWindow((message) => {
        if (message === WM_CLIPBOARDUPDATE && !this.disposed) {
          this.receive?.(this.native.symbols.GetClipboardSequenceNumber());
        }
      });
      if (!this.native.symbols.AddClipboardFormatListener(this.hwnd)) {
        throw new Error("Windows rejected the clipboard format listener.");
      }
    } catch (error) {
      try {
        this.dispose();
      } catch {
        // The registration error is the actionable failure; cleanup already ran best-effort.
      }
      throw error;
    }
  }

  listen(receive: (sequence: number) => void) {
    this.receive = receive;
  }

  dispose() {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.receive = undefined;
    const errors: unknown[] = [];
    try {
      // A listener that was never added reports failure here; destroying the window still releases it.
      if (this.hwnd) {
        this.native.symbols.RemoveClipboardFormatListener(this.hwnd);
      }
    } catch (error) {
      errors.push(error);
    }
    try {
      if (this.hwnd) {
        this.services.destroyWindow(this.hwnd);
      }
    } catch (error) {
      errors.push(error);
    } finally {
      this.hwnd = undefined;
      this.native.close();
    }
    if (errors.length) {
      throw new AggregateError(errors, "Clipboard listener cleanup failed.");
    }
  }
}
