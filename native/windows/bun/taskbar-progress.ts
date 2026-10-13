import type { NativeWindow } from "@bunaway/plugin-api/native";
import { BunawayError } from "@bunaway/protocol";

export type TaskbarProgress = Parameters<
  NonNullable<NativeWindow["setTaskbarProgress"]>
>[0];

/** Own desired progress per HWND, separately from asynchronous Explorer button creation. */
export class TaskbarProgressController {
  private readonly ready = new Set<bigint>();
  private readonly progress = new Map<bigint, TaskbarProgress>();

  constructor(
    private readonly apply: (window: bigint, progress: TaskbarProgress) => void,
  ) {}

  /** Retry the last accepted setting when Explorer creates or recreates a taskbar button. */
  buttonCreated(window: bigint): void {
    this.ready.add(window);
    const progress = this.progress.get(window);
    if (progress) {
      this.apply(window, progress);
    }
  }

  /** Apply synchronously after button creation; failed requests do not replace the accepted setting. */
  set(window: bigint, progress: TaskbarProgress): void {
    if (!this.ready.has(window)) {
      throw new BunawayError({
        code: "BUSY",
        message:
          "The window's taskbar button is not ready. Show the window and retry.",
      });
    }
    this.apply(window, progress);
    this.progress.set(window, {
      ...progress,
    });
  }

  /** Discard the HWND lifetime, including when Windows later reuses the handle value. */
  forget(window: bigint): void {
    this.ready.delete(window);
    this.progress.delete(window);
  }
}
