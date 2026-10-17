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
  const feasible = {
    low: Math.max(primaryRange.low, secondaryRange.low / secondaryPerPrimary),
    high: Math.min(
      primaryRange.high,
      secondaryRange.high / secondaryPerPrimary,
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
    secondary: Math.round(fitted * secondaryPerPrimary),
  };
}

function clientRange(
  minimum: number | null,
  maximum: number | null,
  dpi: number,
): Range {
  return {
    low: minimum === null ? 1 : physicalPixels(minimum, dpi),
    high:
      maximum === null
        ? Number.POSITIVE_INFINITY
        : physicalPixels(maximum, dpi),
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
 * DPI) values converted with `dpi`.
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
): SizingRect {
  const clientWidth = Math.max(1, rect.right - rect.left - frame.width);
  const clientHeight = Math.max(1, rect.bottom - rect.top - frame.height);
  const widthRange = clientRange(
    constraints.minWidth,
    constraints.maxWidth,
    dpi,
  );
  const heightRange = clientRange(
    constraints.minHeight,
    constraints.maxHeight,
    dpi,
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
