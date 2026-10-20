import {
  MAX_WINDOW_DIMENSION,
  MIN_WINDOW_DIMENSION,
} from "@bunaway/plugin-api/native";
import type { Monitor } from "@bunaway/plugin-windows";
import {
  LOGICAL_DPI,
  MIN_VISIBLE_LOGICAL_PIXELS,
  type SavedWindowState,
} from "#window-state/contract";

/** Physical outer rectangle. */
export type Rect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type FittedBounds = {
  bounds: Rect;
  /** The result differs from the saved rectangle. */
  adjusted: boolean;
};

type Bounds = Pick<SavedWindowState, "x" | "y" | "width" | "height" | "dpi">;

function overlap(
  a: Rect,
  b: Rect,
): {
  width: number;
  height: number;
} {
  return {
    width: Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x),
    height: Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y),
  };
}

/**
 * Keep a physical size inside the window size limits, which are logical pixels converted at
 * the monitor's DPI, and inside the work area.
 */
function clampSize(value: number, available: number, dpi: number): number {
  const minimum = Math.ceil((MIN_WINDOW_DIMENSION * dpi) / LOGICAL_DPI);
  const maximum = Math.floor((MAX_WINDOW_DIMENSION * dpi) / LOGICAL_DPI);
  const limit = Math.max(minimum, Math.min(maximum, available));
  return Math.min(Math.max(Math.round(value), minimum), limit);
}

/** The monitor whose work area holds the largest part of the rectangle, if enough of it shows. */
function visibleMonitor(
  saved: Rect,
  monitors: readonly Monitor[],
): Monitor | null {
  let best: Monitor | null = null;
  let bestArea = 0;
  for (const monitor of monitors) {
    const { width, height } = overlap(saved, monitor.workArea);
    const minimum = Math.ceil(
      (MIN_VISIBLE_LOGICAL_PIXELS * monitor.dpi) / LOGICAL_DPI,
    );
    if (
      width >= Math.min(minimum, saved.width) &&
      height >= Math.min(minimum, saved.height)
    ) {
      if (width * height > bestArea) {
        best = monitor;
        bestArea = width * height;
      }
    }
  }
  return best;
}

/**
 * Fit a saved rectangle to the monitors that exist now. A rectangle that still shows at least a
 * small piece of a work area keeps its position; otherwise it is centered on the primary work
 * area. When the monitor under it runs at another DPI than when it was saved, the size follows
 * the DPI ratio so the window keeps its logical size. The size never exceeds the work area.
 */
export function fitToMonitors(
  saved: Bounds,
  monitors: readonly Monitor[],
): FittedBounds {
  const original: Rect = {
    x: saved.x,
    y: saved.y,
    width: saved.width,
    height: saved.height,
  };
  const home = visibleMonitor(original, monitors);
  const target =
    home ?? monitors.find((monitor) => monitor.primary) ?? monitors[0];
  if (!target) {
    return {
      bounds: original,
      adjusted: false,
    };
  }
  const scale = target.dpi / saved.dpi;
  const width = clampSize(
    saved.width * scale,
    target.workArea.width,
    target.dpi,
  );
  const height = clampSize(
    saved.height * scale,
    target.workArea.height,
    target.dpi,
  );
  const area = target.workArea;
  const bounds: Rect = home
    ? {
        x: saved.x,
        y: saved.y,
        width,
        height,
      }
    : {
        x: area.x + Math.floor((area.width - width) / 2),
        y: area.y + Math.floor((area.height - height) / 2),
        width,
        height,
      };
  return {
    bounds,
    adjusted:
      bounds.x !== original.x ||
      bounds.y !== original.y ||
      bounds.width !== original.width ||
      bounds.height !== original.height,
  };
}
