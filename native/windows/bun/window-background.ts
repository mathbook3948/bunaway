import { ptr } from "bun:ffi";
import assert from "node:assert/strict";
import { gdi, user } from "./win32-bindings.ts";

/** GetStockObject: a solid brush whose color is set per device context with SetDCBrushColor. */
const DC_BRUSH = 18;
/** GetStockObject: a black brush; GDI writes alpha 0 with it, so on a transparent window it clears pixels. */
const BLACK_BRUSH = 4;

/** Converts `#rrggbb` to the COLORREF layout 0x00BBGGRR that GDI expects. */
export function colorRef(color: string): number {
  const rgb = Number.parseInt(color.slice(1), 16);
  return ((rgb & 0xff) << 16) | (rgb & 0xff00) | ((rgb >> 16) & 0xff);
}

/**
 * Per-window background colors. The window class keeps its system brush, so a window without an
 * entry erases as before; a registered window is filled with a stock DC brush set to its own
 * color, which creates no GDI object that would need releasing. Colors are always `#rrggbb`.
 * A transparent window has no color; it is cleared to alpha 0 so the desktop shows through.
 */
export class WindowBackgrounds {
  private readonly colors = new Map<bigint, string>();
  private readonly transparent = new Set<bigint>();

  isTransparent(window: bigint): boolean {
    return this.transparent.has(window);
  }

  /** Clear the window to alpha 0 from now on, for a window that never takes a color. */
  setTransparent(window: bigint): void {
    this.transparent.add(window);
  }

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
    this.transparent.delete(window);
  }

  /** Answer WM_ERASEBKGND for a registered window. False leaves the message to the default procedure. */
  erase(window: bigint, deviceContext: bigint): boolean {
    const color = this.colors.get(window);
    const clear = this.transparent.has(window);
    if (color === undefined && !clear) {
      return false;
    }
    const rect = Buffer.alloc(16);
    if (!user.symbols.GetClientRect(window, ptr(rect))) {
      return false;
    }
    if (color === undefined) {
      return (
        user.symbols.FillRect(
          deviceContext,
          ptr(rect),
          gdi.symbols.GetStockObject(BLACK_BRUSH),
        ) !== 0
      );
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
