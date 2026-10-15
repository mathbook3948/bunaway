import { dlopen, ptr } from "bun:ffi";
import type {
  NativeAppearanceWindow,
  NativeAppearanceWindows,
} from "@bunaway/plugin-api/native";
import { BunawayError } from "@bunaway/protocol";

const DWMWA_USE_IMMERSIVE_DARK_MODE = 20;
const E_INVALIDARG = -2147024809;
/** Load only when the optional appearance plugin subscribes. Never retain temporary pointers. */
export function createFrameAppearance() {
  const library = dlopen("dwmapi.dll", {
    DwmSetWindowAttribute: {
      args: [
        "u64",
        "u32",
        "ptr",
        "u32",
      ],
      returns: "i32",
    },
  });
  return {
    setDark(hwnd: bigint, dark: boolean) {
      const value = Buffer.alloc(4);
      value.writeInt32LE(dark ? 1 : 0);
      const result = library.symbols.DwmSetWindowAttribute(
        hwnd,
        DWMWA_USE_IMMERSIVE_DARK_MODE,
        ptr(value),
        value.length,
      );
      if (result < 0) {
        throw new BunawayError({
          code: result === E_INVALIDARG ? "UNSUPPORTED" : "INTERNAL",
          message: "Windows frame appearance could not be applied.",
        });
      }
    },
    dispose: () => library.close(),
  };
}

/** Bridge window lifetimes to one optional plugin owner, without modifying window style creation. */
export class AppearanceWindows implements NativeAppearanceWindows {
  private readonly windows = new Map<string, bigint>();
  private readonly releases = new Map<string, () => void>();
  private receive: ((window: NativeAppearanceWindow) => () => void) | undefined;
  private native: ReturnType<typeof createFrameAppearance> | undefined;

  constructor(private readonly createNative = createFrameAppearance) {}

  /** Attach before WebView initialization; failed registration leaves no capability behind. */
  attach(windowId: string, hwnd: bigint): void {
    if (this.windows.has(windowId)) {
      throw new Error("Appearance lifetime already attached.");
    }
    this.windows.set(windowId, hwnd);
    try {
      this.connect(windowId, hwnd);
    } catch (error) {
      this.detach(windowId);
      throw error;
    }
  }

  private connect(windowId: string, hwnd: bigint): void {
    if (!this.receive || !this.native) {
      return;
    }
    const native = this.native;
    const release = this.receive({
      windowId,
      setDark: (dark) => {
        if (this.windows.get(windowId) !== hwnd || this.native !== native) {
          throw new BunawayError({
            code: "CANCELLED",
            message: "Appearance window lifetime ended.",
          });
        }
        native.setDark(hwnd, dark);
      },
    });
    this.releases.set(windowId, release);
  }

  /** Retire capabilities before DestroyWindow; no late callback may address a recycled HWND. */
  detach(windowId: string): void {
    this.windows.delete(windowId);
    this.releases.get(windowId)?.();
    this.releases.delete(windowId);
  }

  subscribe(
    receive: (window: NativeAppearanceWindow) => () => void,
  ): () => void {
    if (this.native) {
      throw new Error("Appearance windows already subscribed.");
    }
    const native = this.createNative();
    this.native = native;
    this.receive = receive;
    const release = () => {
      if (this.native !== native) {
        return;
      }
      this.receive = undefined;
      const errors: unknown[] = [];
      for (const [id, hwnd] of this.windows) {
        try {
          this.releases.get(id)?.();
        } catch (error) {
          errors.push(error);
        }
        try {
          native.setDark(hwnd, false);
        } catch (error) {
          // Unsupported DWM attributes never changed the frame, so there is nothing to reset.
          if (
            !(error instanceof BunawayError) ||
            error.code !== "UNSUPPORTED"
          ) {
            errors.push(error);
          }
        }
      }
      this.releases.clear();
      native.dispose();
      this.native = undefined;
      if (errors.length) {
        throw new AggregateError(errors, "Appearance frame reset failed.");
      }
    };
    try {
      for (const [id, hwnd] of this.windows) {
        this.connect(id, hwnd);
      }
    } catch (error) {
      try {
        release();
      } catch (cleanup) {
        throw new AggregateError(
          [
            error,
            cleanup,
          ],
          "Appearance initialization failed.",
        );
      }
      throw error;
    }
    return release;
  }
}
