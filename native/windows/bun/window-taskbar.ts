import assert from "node:assert/strict";
import { withWide } from "@bunaway/plugin/win32";
import type {
  NativeOverlayIconProvider,
  NativeThumbnailButton,
} from "@bunaway/plugin-api/native";
import { BunawayError } from "@bunaway/protocol";
import { Taskbar } from "./taskbar.ts";
import {
  type OverlayIconSetting,
  type TaskbarProgress,
  TaskbarProgressController,
  TaskbarSettingController,
  type ThumbnailClip,
} from "./taskbar-progress.ts";
import {
  pressedThumbnailButton,
  type ThumbnailToolbar,
  thumbnailSlots,
  thumbnailToolbarOf,
} from "./thumbnail-toolbar.ts";
import { user } from "./win32-bindings.ts";
import { SM_CXSMICON } from "./win32-constants.ts";
import { clampPixelRect, fitsInt32Rect, physicalRect } from "./window-size.ts";

/** What the taskbar needs to know about a window from its owner. */
export type TaskbarWindowHost = {
  dpi(window: bigint): number;
  isMinimized(window: bigint): boolean;
  clientSize(window: bigint): {
    width: number;
    height: number;
  };
};

/**
 * The per-window taskbar settings of one window class: progress, thumbnail clip and tooltip, the
 * thumbnail toolbar and the overlay icon, whose HICONs this object owns. Settings are retained so an Explorer restart
 * (`TaskbarButtonCreated`) can restore them.
 */
export class WindowTaskbar {
  private readonly taskbar = new Taskbar();
  private readonly progress = new TaskbarProgressController(
    (window, progress) => this.taskbar.apply(window, progress),
  );
  // Clip is kept in DIPs and converted at each application, so a button recreated after a DPI change
  // gets the current scale.
  private readonly thumbnailClip = new TaskbarSettingController<ThumbnailClip>(
    (window, region) => this.applyThumbnailClip(window, region),
  );
  private readonly thumbnailToolTip = new TaskbarSettingController<
    string | null
  >((window, toolTip) => this.taskbar.setThumbnailToolTip(window, toolTip));
  // The HICON currently shown as each window's overlay; owned here and destroyed on replacement, removal or destroy.
  private readonly overlayIcons = new Map<bigint, bigint>();
  private readonly overlayIcon =
    new TaskbarSettingController<OverlayIconSetting>(
      (window, setting) => this.applyOverlayIcon(window, setting),
      // The provider is a function, which structuredClone rejects; the setting is never mutated.
      (setting) => setting,
    );
  // The toolbar buttons currently shown per window, and the HICONs they use. Windows accepts
  // ThumbBarAddButtons once per taskbar button, so `toolbarAdded` selects Add or Update.
  private readonly toolbars = new Map<bigint, ThumbnailToolbar>();
  private readonly toolbarIcons = new Map<bigint, bigint[]>();
  private readonly toolbarAdded = new Set<bigint>();
  private readonly thumbnailToolbar = new TaskbarSettingController<
    readonly NativeThumbnailButton[]
  >(
    (window, buttons) => this.applyThumbnailToolbar(window, buttons),
    // The icon providers are functions, which structuredClone rejects; the list is never mutated.
    (buttons) => buttons,
  );
  /** The message Explorer posts to each window when it (re)creates the taskbar button. */
  readonly buttonCreatedMessage = withWide("TaskbarButtonCreated", (name) =>
    user.symbols.RegisterWindowMessageW(name),
  );

  constructor(private readonly host: TaskbarWindowHost) {
    assert(
      this.buttonCreatedMessage,
      "RegisterWindowMessageW(TaskbarButtonCreated) failed",
    );
  }

  /** Re-apply every retained setting after Explorer created the button; one failure cannot skip the others. */
  restore(window: bigint): void {
    // A recreated taskbar button has no toolbar yet, so the next application must Add rather than Update.
    this.toolbarAdded.delete(window);
    for (const [name, controller] of [
      [
        "progress",
        this.progress,
      ],
      [
        "thumbnail clip",
        this.thumbnailClip,
      ],
      [
        "thumbnail tooltip",
        this.thumbnailToolTip,
      ],
      [
        "overlay icon",
        this.overlayIcon,
      ],
      [
        "thumbnail toolbar",
        this.thumbnailToolbar,
      ],
    ] as const) {
      try {
        controller.buttonCreated(window);
      } catch (error) {
        // Explorer recreation is asynchronous; retain the last accepted setting for a later retry.
        console.error(
          `Could not restore taskbar ${name} after button creation.`,
          error,
        );
      }
    }
  }

  /** Apply progress to a live HWND without changing visibility, activation or window state. */
  setProgress(window: bigint, progress: TaskbarProgress): void {
    this.progress.set(window, progress);
  }

  /**
   * Clip the taskbar thumbnail to a client-area rectangle in 96 DPI logical pixels, or clear it for null.
   * Parts beyond the client area are clamped away; a region left empty by that is rejected.
   */
  setThumbnailClip(window: bigint, region: ThumbnailClip): void {
    this.thumbnailClip.set(window, region);
  }

  /** Set the taskbar thumbnail tooltip, or restore the window title for null or an empty string. */
  setThumbnailToolTip(window: bigint, toolTip: string | null): void {
    // Native callers bypass the plugin schema; enforce the same limits as window titles.
    if (toolTip !== null && (toolTip.includes("\0") || toolTip.length > 1024)) {
      throw new BunawayError({
        code: "INVALID_ARGUMENT",
        message:
          "The thumbnail tooltip cannot contain NUL or exceed 1024 UTF-16 code units.",
      });
    }
    this.thumbnailToolTip.set(window, toolTip || null);
  }

  /**
   * Show the overlay icon with an accessibility description on the taskbar button, or remove it for null
   * (the description is then ignored).
   */
  setOverlayIcon(
    window: bigint,
    icon: NativeOverlayIconProvider | null,
    description: string,
  ): void {
    if (icon === null) {
      this.overlayIcon.set(window, null);
      return;
    }
    // Native callers bypass the plugin schema; enforce the same limits as the thumbnail tooltip.
    if (description.includes("\0") || description.length > 1024) {
      throw new BunawayError({
        code: "INVALID_ARGUMENT",
        message:
          "The overlay icon description cannot contain NUL or exceed 1024 UTF-16 code units.",
      });
    }
    this.overlayIcon.set(window, {
      icon,
      description,
    });
  }

  /**
   * Replace the thumbnail toolbar with `buttons`, or hide every button for an empty list. Buttons keep
   * their order; the shell reports a press as the slot index, which `pressedButton` maps back to the id.
   */
  setThumbnailToolbar(
    window: bigint,
    buttons: readonly NativeThumbnailButton[],
  ): void {
    thumbnailToolbarOf(buttons);
    this.thumbnailToolbar.set(window, buttons);
  }

  /** The app's id of the button a WM_COMMAND wParam presses, or undefined when it presses none that is usable. */
  pressedButton(window: bigint, wparam: bigint): string | undefined {
    return pressedThumbnailButton(this.toolbars.get(window), wparam);
  }

  /** Drop every retained setting and the HICONs of a window that is being destroyed. */
  forget(window: bigint): void {
    this.progress.forget(window);
    this.thumbnailClip.forget(window);
    this.thumbnailToolTip.forget(window);
    this.overlayIcon.forget(window);
    this.releaseOverlayIcon(window);
    this.thumbnailToolbar.forget(window);
    this.releaseToolbar(window);
    this.toolbarAdded.delete(window);
  }

  /** Backstop for icons whose window never reached its normal destroy path. Safe to repeat. */
  releaseIcons(): void {
    for (const window of [
      ...this.overlayIcons.keys(),
    ]) {
      this.releaseOverlayIcon(window);
    }
    for (const window of [
      ...this.toolbarIcons.keys(),
    ]) {
      this.releaseToolbar(window);
    }
  }

  /** Release the icons and the shell interface. Call after every window is destroyed. */
  dispose(): void {
    this.releaseIcons();
    this.taskbar.dispose();
  }

  /**
   * Build the new HICON at the small icon size for the window's DPI before touching the shell, so a rejected
   * image keeps the current overlay. The previous HICON is destroyed only after the shell accepted the new one.
   */
  private applyOverlayIcon(window: bigint, setting: OverlayIconSetting): void {
    if (!setting) {
      this.taskbar.setOverlayIcon(window, 0n, "");
      this.releaseOverlayIcon(window);
      return;
    }
    const size = user.symbols.GetSystemMetricsForDpi(
      SM_CXSMICON,
      this.host.dpi(window),
    );
    // The provider's HICON belongs to this class from here on, including when the shell call fails.
    const icon = setting.icon(size);
    try {
      this.taskbar.setOverlayIcon(window, icon, setting.description);
    } catch (error) {
      user.symbols.DestroyIcon(icon);
      throw error;
    }
    this.releaseOverlayIcon(window);
    this.overlayIcons.set(window, icon);
  }

  /**
   * Build every HICON at the small icon size for the window's DPI before touching the shell, so a rejected
   * image keeps the current toolbar. The previous HICONs are destroyed only after the shell accepted the new ones.
   */
  private applyThumbnailToolbar(
    window: bigint,
    buttons: readonly NativeThumbnailButton[],
  ): void {
    const toolbar = thumbnailToolbarOf(buttons);
    if (buttons.length === 0 && !this.toolbarAdded.has(window)) {
      // Nothing was ever shown, so there is nothing to hide.
      this.toolbars.set(window, toolbar);
      return;
    }
    const size = user.symbols.GetSystemMetricsForDpi(
      SM_CXSMICON,
      this.host.dpi(window),
    );
    const icons: bigint[] = [];
    try {
      for (const button of buttons) {
        // Each provider HICON belongs to this class from here on, including when a later step fails.
        icons.push(button.icon(size));
      }
      this.taskbar.setThumbnailButtons(
        window,
        thumbnailSlots(toolbar, buttons, icons),
        !this.toolbarAdded.has(window),
      );
    } catch (error) {
      for (const icon of icons) {
        user.symbols.DestroyIcon(icon);
      }
      throw error;
    }
    this.toolbarAdded.add(window);
    this.releaseToolbar(window);
    this.toolbarIcons.set(window, icons);
    this.toolbars.set(window, toolbar);
  }

  private releaseToolbar(window: bigint): void {
    for (const icon of this.toolbarIcons.get(window) ?? []) {
      user.symbols.DestroyIcon(icon);
    }
    this.toolbarIcons.delete(window);
    this.toolbars.delete(window);
  }

  private releaseOverlayIcon(window: bigint): void {
    const icon = this.overlayIcons.get(window);
    if (icon) {
      user.symbols.DestroyIcon(icon);
      this.overlayIcons.delete(window);
    }
  }

  private applyThumbnailClip(window: bigint, region: ThumbnailClip): void {
    if (!region) {
      this.taskbar.setThumbnailClip(window, null);
      return;
    }
    // Native callers bypass the plugin schema, so check the contract before converting.
    const invalidInput = [
      region.x,
      region.y,
      region.width,
      region.height,
    ].some((value) => !Number.isInteger(value));
    const rect = invalidInput
      ? null
      : physicalRect(region, this.host.dpi(window));
    if (
      !rect ||
      !fitsInt32Rect(rect) ||
      rect.left < 0 ||
      rect.top < 0 ||
      rect.right <= rect.left ||
      rect.bottom <= rect.top
    ) {
      throw new BunawayError({
        code: "INVALID_ARGUMENT",
        message:
          "The thumbnail clip must be a non-empty region inside the client origin.",
      });
    }
    // A minimized HWND reports an empty client rectangle. Its restored size is not the WINDOWPLACEMENT
    // normal rectangle when it was minimized from maximized or fullscreen, so it is not reliably known:
    // pass the region through unclipped. Otherwise clamp to the current client area, which also
    // lets a rounded fractional-DPI edge reach the last pixel.
    const clipped = this.host.isMinimized(window)
      ? rect
      : clampPixelRect(rect, this.host.clientSize(window));
    if (!clipped) {
      throw new BunawayError({
        code: "INVALID_ARGUMENT",
        message: "The thumbnail clip lies entirely outside the client area.",
      });
    }
    this.taskbar.setThumbnailClip(window, clipped);
  }
}
