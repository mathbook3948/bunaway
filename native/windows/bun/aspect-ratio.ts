import type { WindowSizeConstraints } from "@bunaway/plugin-api/native";
import { physicalPixels } from "./window-size.ts";

/** WM_SIZING wParam values naming the edge or corner the user is dragging. */
export const WMSZ_LEFT = 1;
export const WMSZ_RIGHT = 2;
export const WMSZ_TOP = 3;
export const WMSZ_TOPLEFT = 4;
export const WMSZ_TOPRIGHT = 5;
export const WMSZ_BOTTOM = 6;
export const WMSZ_BOTTOMLEFT = 7;
export const WMSZ_BOTTOMRIGHT = 8;

/** Outer window rectangle in physical screen pixels, as in the WM_SIZING RECT. */
export type SizingRect = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

type Range = {
  low: number;
  high: number;
};

const clampTo = (value: number, range: Range) =>
  Math.max(range.low, Math.min(range.high, value));

/**
 * Pick the primary-axis size whose derived secondary size stays inside both
 * ranges. When the constraints cannot hold the ratio together, the constraints
 * win and each axis is clamped independently, so the ratio is relaxed instead
 * of violating a minimum or maximum size.
 *
 * @param secondaryPerPrimary secondary size divided by primary size.
 */
function fitAxes(
  primary: number,
  secondaryPerPrimary: number,
  primaryRange: Range,
  secondaryRange: Range,
) {
  // Integer pixels only: round the real-valued interval inward so every
  // primary size in it derives a secondary size inside its range.
  const feasible = {
    low: Math.ceil(
      Math.max(primaryRange.low, secondaryRange.low / secondaryPerPrimary),
    ),
    high: Math.floor(
      Math.min(primaryRange.high, secondaryRange.high / secondaryPerPrimary),
    ),
  };
  if (feasible.low > feasible.high) {
    const fixedPrimary = clampTo(primary, primaryRange);
    return {
      primary: Math.round(fixedPrimary),
      secondary: Math.round(
        clampTo(fixedPrimary * secondaryPerPrimary, secondaryRange),
      ),
    };
  }
  const fitted = Math.round(clampTo(primary, feasible));
  return {
    primary: fitted,
    // Rounding the derived axis must not leave its range.
    secondary: Math.round(
      clampTo(Math.round(fitted * secondaryPerPrimary), secondaryRange),
    ),
  };
}

/** Outer window size limits of the system, in physical pixels (WM_GETMINMAXINFO track sizes). */
export type SystemTrackSize = {
  minWidth: number;
  minHeight: number;
  maxWidth: number;
  maxHeight: number;
};

/**
 * Client-area range on one axis: the user's logical constraint converted by
 * DPI, intersected with the system track size minus the frame, so the ratio
 * agrees with what WM_GETMINMAXINFO would enforce afterwards. When the two do
 * not overlap, the minimum wins and the range collapses to it. This mirrors
 * applyMinMaxInfo (max of minimums, min of maximums) and the minimum-wins
 * fix-up of ptMaxTrackSize in the user32 path, as read from ReactOS
 * co_WinPosGetMinMaxInfo; the behavior of Windows itself was not verified.
 */
function clientRange(
  minimum: number | null,
  maximum: number | null,
  dpi: number,
  systemMinimum: number,
  systemMaximum: number,
  frame: number,
): Range {
  const system = {
    low: Math.max(1, systemMinimum - frame),
    high: Math.max(1, systemMaximum - frame),
  };
  const low = Math.max(
    system.low,
    minimum === null ? 1 : physicalPixels(minimum, dpi),
  );
  // The minimum wins when the ranges do not overlap, as in applyMinMaxInfo
  // followed by the user32 fix-up of ptMaxTrackSize to at least ptMinTrackSize.
  const high = Math.max(
    low,
    Math.min(
      system.high,
      maximum === null
        ? Number.POSITIVE_INFINITY
        : physicalPixels(maximum, dpi),
    ),
  );
  return {
    low,
    high,
  };
}

/**
 * Adjust a WM_SIZING rectangle so its client area keeps `ratio` (width / height).
 *
 * The dragged edge decides which axis leads: left and right edges lead with
 * width, top and bottom edges with height, and a corner leads with the axis
 * that makes the window larger. The other axis is derived. The edge opposite
 * the drag stays fixed, and a side edge moves the bottom, a top or bottom edge
 * moves the right side. `frame` is the physical non-client size, the ratio and
 * `constraints` apply to the client area, and the constraints are logical (96
 * DPI) values converted with `dpi`. `track` is the system minimum and maximum
 * outer size for the window's DPI; it narrows the constraints, and when the
 * ranges cannot hold the ratio they win over it.
 */
export function adjustSizingRect(
  rect: SizingRect,
  edge: number,
  ratio: number,
  frame: {
    width: number;
    height: number;
  },
  dpi: number,
  constraints: WindowSizeConstraints,
  track: SystemTrackSize,
): SizingRect {
  const clientWidth = Math.max(1, rect.right - rect.left - frame.width);
  const clientHeight = Math.max(1, rect.bottom - rect.top - frame.height);
  const widthRange = clientRange(
    constraints.minWidth,
    constraints.maxWidth,
    dpi,
    track.minWidth,
    track.maxWidth,
    frame.width,
  );
  const heightRange = clientRange(
    constraints.minHeight,
    constraints.maxHeight,
    dpi,
    track.minHeight,
    track.maxHeight,
    frame.height,
  );
  const widthLeads =
    edge === WMSZ_LEFT ||
    edge === WMSZ_RIGHT ||
    (edge !== WMSZ_TOP &&
      edge !== WMSZ_BOTTOM &&
      clientWidth >= clientHeight * ratio);
  let width: number;
  let height: number;
  if (widthLeads) {
    const fitted = fitAxes(clientWidth, 1 / ratio, widthRange, heightRange);
    width = fitted.primary;
    height = fitted.secondary;
  } else {
    const fitted = fitAxes(clientHeight, ratio, heightRange, widthRange);
    height = fitted.primary;
    width = fitted.secondary;
  }
  const outerWidth = width + frame.width;
  const outerHeight = height + frame.height;
  const movesLeft =
    edge === WMSZ_LEFT || edge === WMSZ_TOPLEFT || edge === WMSZ_BOTTOMLEFT;
  const movesTop =
    edge === WMSZ_TOP || edge === WMSZ_TOPLEFT || edge === WMSZ_TOPRIGHT;
  return {
    left: movesLeft ? rect.right - outerWidth : rect.left,
    top: movesTop ? rect.bottom - outerHeight : rect.top,
    right: movesLeft ? rect.right : rect.left + outerWidth,
    bottom: movesTop ? rect.bottom : rect.top + outerHeight,
  };
}
