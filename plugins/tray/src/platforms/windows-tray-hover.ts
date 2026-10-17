import type { NativeTrayEvent } from "@bunaway/plugin-api/native";

/** Minimum spacing between `move` events while the pointer stays over the icon. */
export const TRAY_MOVE_INTERVAL_MS = 50;
/** How often the pointer is compared with the icon bounds to detect `leave`. */
export const TRAY_LEAVE_POLL_MS = 100;

type Point = {
  x: number;
  y: number;
};
type Rect = Point & {
  width: number;
  height: number;
};

/** Environment seams, so the state machine runs without a shell or real timers. */
export type TrayHoverHost = {
  now(): number;
  cursor(): Point | null;
  bounds(): Rect | null;
  emit(event: NativeTrayEvent): void;
  /** Starts a repeating timer and returns its stop function. */
  startPolling(poll: () => void, intervalMs: number): () => void;
};

/**
 * Derives enter/move/leave from shell mouse-move callbacks.
 *
 * Shell_NotifyIcon reports only WM_MOUSEMOVE and never a "pointer left" message, so leave is
 * inferred: while hovering, a timer compares the cursor with Shell_NotifyIconGetRect and ends
 * the hover once the cursor is outside. Leave is therefore delayed by up to TRAY_LEAVE_POLL_MS,
 * and an unreadable icon rectangle is treated as "outside" because it cannot be verified.
 */
export class TrayHoverTracker {
  private stopPolling: (() => void) | undefined;
  private lastMoveAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly host: TrayHoverHost) {}

  /** Handle one WM_MOUSEMOVE callback: first one enters, later ones are throttled moves. */
  mouseMoved() {
    const now = this.host.now();
    if (!this.stopPolling) {
      this.lastMoveAt = now;
      this.stopPolling = this.host.startPolling(
        () => this.checkLeft(),
        TRAY_LEAVE_POLL_MS,
      );
      this.publish("enter");
    } else if (now - this.lastMoveAt >= TRAY_MOVE_INTERVAL_MS) {
      this.lastMoveAt = now;
      this.publish("move");
    }
  }

  /** Stop polling without emitting leave. Safe to repeat. */
  dispose() {
    this.stopPolling?.();
    this.stopPolling = undefined;
  }

  private checkLeft() {
    const cursor = this.host.cursor();
    const bounds = this.host.bounds();
    const inside =
      cursor !== null &&
      bounds !== null &&
      cursor.x >= bounds.x &&
      cursor.x < bounds.x + bounds.width &&
      cursor.y >= bounds.y &&
      cursor.y < bounds.y + bounds.height;
    if (!inside) {
      this.dispose();
      this.publish("leave");
    }
  }

  private publish(state: "enter" | "move" | "leave") {
    this.host.emit({
      id: "main",
      button: "none",
      state,
      position: this.host.cursor(),
    });
  }
}
