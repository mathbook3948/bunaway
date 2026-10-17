import {
  clampWindowSize,
  INT32_MAX,
  type WindowSizeConstraints,
} from "@bunaway/plugin-api/native";

export const DEFAULT_DPI = 96;

/** Convert a 96-DPI logical dimension to physical pixels for the target DPI. */
export function physicalPixels(logicalPixels: number, dpi: number) {
  return Math.round((logicalPixels * dpi) / DEFAULT_DPI);
}

/** Physical pixel edges of a client-area rectangle. */
export type PixelRect = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

/**
 * Convert a logical rectangle by rounding its edges, not its size, so adjacent
 * rectangles still share an edge at fractional scale factors.
 */
export function physicalRect(
  region: {
    x: number;
    y: number;
    width: number;
    height: number;
  },
  dpi: number,
): PixelRect {
  return {
    left: physicalPixels(region.x, dpi),
    top: physicalPixels(region.y, dpi),
    right: physicalPixels(region.x + region.width, dpi),
    bottom: physicalPixels(region.y + region.height, dpi),
  };
}

/**
 * Cut a non-empty rectangle to a client area of the given physical size.
 * Returns null when nothing remains, i.e. the rectangle starts at or beyond the right or bottom edge.
 */
export function clampPixelRect(
  rect: PixelRect,
  client: {
    width: number;
    height: number;
  },
): PixelRect | null {
  if (rect.left >= client.width || rect.top >= client.height) {
    return null;
  }
  return {
    ...rect,
    right: Math.min(rect.right, client.width),
    bottom: Math.min(rect.bottom, client.height),
  };
}

/** Whether every edge fits the signed 32-bit RECT fields, so native packing cannot truncate it. */
export function fitsInt32Rect(rect: PixelRect): boolean {
  return [
    rect.left,
    rect.top,
    rect.right,
    rect.bottom,
  ].every((edge) => Number.isInteger(edge) && Math.abs(edge) <= INT32_MAX);
}

/** Convert a physical pixel dimension back to 96-DPI logical pixels. */
export function logicalPixels(physicalPixels: number, dpi: number) {
  return Math.round((physicalPixels * DEFAULT_DPI) / dpi);
}

/**
 * Apply logical client constraints to a maximized physical WINDOWPOS.
 * Unchanged axes retain their exact physical values.
 */
export function constrainedOuterSize(
  width: number,
  height: number,
  dpi: number,
  frame: {
    width: number;
    height: number;
  },
  constraints: WindowSizeConstraints,
) {
  const clientWidth = logicalPixels(width - frame.width, dpi);
  const clientHeight = logicalPixels(height - frame.height, dpi);
  const clamped = clampWindowSize(clientWidth, clientHeight, constraints);
  return {
    width:
      clamped.width === clientWidth
        ? width
        : physicalPixels(clamped.width, dpi) + frame.width,
    height:
      clamped.height === clientHeight
        ? height
        : physicalPixels(clamped.height, dpi) + frame.height,
  };
}
