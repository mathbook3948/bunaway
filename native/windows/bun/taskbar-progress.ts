import type {
  NativeOverlayIconProvider,
  NativeWindow,
} from "@bunaway/plugin-api/native";
import { BunawayError } from "@bunaway/protocol";

export type TaskbarProgress = Parameters<
  NonNullable<NativeWindow["setTaskbarProgress"]>
>[0];

/** Client-area DIP rectangle, or null to show the whole client area. */
export type ThumbnailClip = Parameters<
  NonNullable<NativeWindow["setThumbnailClip"]>
>[0];

/** Overlay icon provider with its accessibility description, or null for no overlay. */
export type OverlayIconSetting = {
  icon: NativeOverlayIconProvider;
  description: string;
} | null;

/** Own one desired taskbar setting per HWND, separately from asynchronous Explorer button creation. */
export class TaskbarSettingController<T> {
  private readonly ready = new Set<bigint>();
  // Boxed because a valid setting may itself be null (cleared clip or tooltip).
  private readonly settings = new Map<
    bigint,
    {
      value: T;
    }
  >();

  /** `copy` isolates the saved setting from later caller mutation; override it for settings structuredClone cannot copy. */
  constructor(
    private readonly apply: (window: bigint, setting: T) => void,
    private readonly copy: (setting: T) => T = structuredClone,
  ) {}

  /** Retry the last accepted setting when Explorer creates or recreates a taskbar button. */
  buttonCreated(window: bigint): void {
    this.ready.add(window);
    const saved = this.settings.get(window);
    if (saved) {
      this.apply(window, saved.value);
    }
  }

  /** Apply synchronously after button creation; failed requests do not replace the accepted setting. */
  set(window: bigint, setting: T): void {
    if (!this.ready.has(window)) {
      throw new BunawayError({
        code: "BUSY",
        message:
          "The window's taskbar button is not ready. Show the window and retry.",
      });
    }
    this.apply(window, setting);
    this.settings.set(window, {
      value: this.copy(setting),
    });
  }

  /** Discard the HWND lifetime, including when Windows later reuses the handle value. */
  forget(window: bigint): void {
    this.ready.delete(window);
    this.settings.delete(window);
  }
}

export class TaskbarProgressController extends TaskbarSettingController<TaskbarProgress> {}
