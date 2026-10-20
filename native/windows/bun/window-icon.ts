import assert from "node:assert/strict";
import type { NativeOverlayIconProvider } from "@bunaway/plugin-api/native";
import { user } from "./win32-bindings.ts";
import {
  ICON_BIG,
  ICON_SMALL,
  SM_CXICON,
  SM_CXSMICON,
  WM_SETICON,
} from "./win32-constants.ts";

/** The two HICONs a window shows: the small one for the title bar, the big one for Alt+Tab and the taskbar. */
type WindowIcons = {
  small: bigint;
  big: bigint;
};

/**
 * Per-window icons that replace the window class (EXE resource) icon. This object owns every HICON it
 * sets: they are destroyed on replacement, on reset to the class icon, and after the window is
 * destroyed. Windows only borrows an icon given through WM_SETICON, so destroying one that is still
 * set would leave a dangling handle in the window.
 */
export class WindowIconSet {
  private readonly icons = new Map<bigint, WindowIcons>();

  /** True while an icon set through `set` is applied to the window. */
  has(window: bigint): boolean {
    return this.icons.has(window);
  }

  /**
   * Replace the window's icons with frames of the provider at the small and big sizes of its DPI. Both
   * HICONs are built before the window is touched, so a rejected image keeps the current icon.
   */
  set(window: bigint, provider: NativeOverlayIconProvider, dpi: number): void {
    assert(user.symbols.IsWindow(window), "Window is no longer valid.");
    const small = provider(
      user.symbols.GetSystemMetricsForDpi(SM_CXSMICON, dpi),
    );
    let big: bigint;
    try {
      big = provider(user.symbols.GetSystemMetricsForDpi(SM_CXICON, dpi));
    } catch (error) {
      user.symbols.DestroyIcon(small);
      throw error;
    }
    const previous = this.icons.get(window);
    user.symbols.SendMessageW(window, WM_SETICON, BigInt(ICON_SMALL), small);
    user.symbols.SendMessageW(window, WM_SETICON, BigInt(ICON_BIG), big);
    this.icons.set(window, {
      small,
      big,
    });
    this.destroy(previous);
  }

  /** Return the window to the class icon and release the icons it was showing. Safe when none is set. */
  clear(window: bigint): void {
    const current = this.icons.get(window);
    if (!current) {
      return;
    }
    if (user.symbols.IsWindow(window)) {
      user.symbols.SendMessageW(window, WM_SETICON, BigInt(ICON_SMALL), 0n);
      user.symbols.SendMessageW(window, WM_SETICON, BigInt(ICON_BIG), 0n);
    }
    this.icons.delete(window);
    this.destroy(current);
  }

  /** Release the icons of a window that has been destroyed. */
  forget(window: bigint): void {
    const current = this.icons.get(window);
    this.icons.delete(window);
    this.destroy(current);
  }

  /** Backstop for icons whose window never reached its normal destroy path. Safe to repeat. */
  releaseAll(): void {
    for (const window of [
      ...this.icons.keys(),
    ]) {
      this.forget(window);
    }
  }

  private destroy(icons: WindowIcons | undefined): void {
    if (icons) {
      user.symbols.DestroyIcon(icons.small);
      user.symbols.DestroyIcon(icons.big);
    }
  }
}
