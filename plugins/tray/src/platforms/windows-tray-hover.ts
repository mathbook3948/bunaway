/** Hover notification published as `tray.hover`; separate from click-style `tray.input`. */
export type TrayHoverEvent = {
  state: "enter" | "move" | "leave";
  position: {
    x: number;
    y: number;
  } | null;
};

/** Minimum spacing between `move` events while the pointer stays over the icon. */
export const TRAY_MOVE_INTERVAL_MS = 50;
/** How often the pointer is compared with the icon bounds to detect `leave`. */
export const TRAY_LEAVE_POLL_MS = 100;
/**
 * With unreadable icon bounds, hover lasts while mouse-move callbacks keep arriving within this
 * window (two poll periods, so one late timer tick does not end an active hover).
 */
export const TRAY_MOVE_FRESH_MS = TRAY_LEAVE_POLL_MS * 2;

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
  emit(event: TrayHoverEvent): void;
  /** Starts a repeating timer and returns its stop function. */
  startPolling(poll: () => void, intervalMs: number): () => void;
  /** Receives failures of the timer-driven check, which has no caller to propagate to. */
  fail(error: unknown): void;
};

/**
 * Derives enter/move/leave from shell mouse-move callbacks.
 *
 * Shell_NotifyIcon reports only WM_MOUSEMOVE and never a "pointer left" message, so leave is
 * inferred: while hovering, a timer compares the cursor with Shell_NotifyIconGetRect and ends
 * the hover once the cursor is outside. Leave is therefore delayed by up to TRAY_LEAVE_POLL_MS.
 * When the rectangle is unreadable (for example an icon in the overflow area), the pointer
 * cannot be located, so hover continues only while mouse-move callbacks keep arriving; leave
 * then comes once no move was seen for TRAY_MOVE_FRESH_MS, at most about
 * TRAY_MOVE_FRESH_MS + TRAY_LEAVE_POLL_MS (300ms) after the last move.
 *
 * Failure policy differs by path. enter and move run inside the window procedure, so an
 * exception from `emit` propagates to the window procedure's caller like any other tray callback.
 * leave runs from the timer, which has no caller: an exception from the cursor/bounds query or
 * from `emit` is reported to `fail` and hover tracking stops without a leave. The next
 * mouse-move callback starts a new hover with enter.
 */
export class TrayHoverTracker {
  private stopPolling: (() => void) | undefined;
  private lastMoveEventAt = Number.NEGATIVE_INFINITY;
  private lastMouseMoveAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly host: TrayHoverHost) {}

  /** Handle one WM_MOUSEMOVE callback: first one enters, later ones are throttled moves. */
  mouseMoved() {
    const now = this.host.now();
    this.lastMouseMoveAt = now;
    if (!this.stopPolling) {
      this.lastMoveEventAt = now;
      this.stopPolling = this.host.startPolling(
        () => this.poll(),
        TRAY_LEAVE_POLL_MS,
      );
      this.publish("enter", this.host.cursor());
    } else if (now - this.lastMoveEventAt >= TRAY_MOVE_INTERVAL_MS) {
      this.lastMoveEventAt = now;
      this.publish("move", this.host.cursor());
    }
  }

  /** Stop polling without emitting leave. Safe to repeat. */
  dispose() {
    this.stopPolling?.();
    this.stopPolling = undefined;
  }

  private poll() {
    try {
      this.checkLeft();
    } catch (error) {
      this.dispose();
      this.host.fail(error);
    }
  }

  private checkLeft() {
    const cursor = this.host.cursor();
    const bounds = this.host.bounds();
    const inside =
      cursor !== null &&
      (bounds === null
        ? this.host.now() - this.lastMouseMoveAt < TRAY_MOVE_FRESH_MS
        : cursor.x >= bounds.x &&
          cursor.x < bounds.x + bounds.width &&
          cursor.y >= bounds.y &&
          cursor.y < bounds.y + bounds.height);
    if (!inside) {
      // Stop first so a throwing subscriber cannot leave a timer running.
      this.dispose();
      // Report the position that decided the leave, not a second later query.
      this.publish("leave", cursor);
    }
  }

  private publish(state: "enter" | "move" | "leave", position: Point | null) {
    this.host.emit({
      state,
      position,
    });
  }
}
