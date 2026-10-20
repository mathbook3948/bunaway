import { ptr } from "bun:ffi";
import assert from "node:assert/strict";
import { gdi, user } from "./win32-bindings.ts";

/** GetStockObject: a solid brush whose color is set per device context with SetDCBrushColor. */
const DC_BRUSH = 18;

/** Converts `#rrggbb` to the COLORREF layout 0x00BBGGRR that GDI expects. */
export function colorRef(color: string): number {
  const rgb = Number.parseInt(color.slice(1), 16);
  return ((rgb & 0xff) << 16) | (rgb & 0xff00) | ((rgb >> 16) & 0xff);
}

/**
 * Per-window background colors. The window class keeps its system brush, so a window without an
 * entry erases as before; a registered window is filled with a stock DC brush set to its own
 * color, which creates no GDI object that would need releasing. Colors are always `#rrggbb`.
 */
export class WindowBackgrounds {
  private readonly colors = new Map<bigint, string>();

  get(window: bigint): string | null {
    return this.colors.get(window) ?? null;
  }

  /** Remember the color and repaint the client area so the change is visible immediately. */
  set(window: bigint, color: string): void {
    assert(user.symbols.IsWindow(window), "Window is no longer valid.");
    this.colors.set(window, color);
    user.symbols.InvalidateRect(window, null, 1);
  }

  /** Drop the entry when the window is destroyed. */
  forget(window: bigint): void {
    this.colors.delete(window);
  }

  /** Answer WM_ERASEBKGND for a registered window. False leaves the message to the default procedure. */
  erase(window: bigint, deviceContext: bigint): boolean {
    const color = this.colors.get(window);
    if (color === undefined) {
      return false;
    }
    const rect = Buffer.alloc(16);
    if (!user.symbols.GetClientRect(window, ptr(rect))) {
      return false;
    }
    gdi.symbols.SetDCBrushColor(deviceContext, colorRef(color));
    return (
      user.symbols.FillRect(
        deviceContext,
        ptr(rect),
        gdi.symbols.GetStockObject(DC_BRUSH),
      ) !== 0
    );
  }
}
