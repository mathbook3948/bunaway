import {
  clampWindowSize,
  type WindowSizeConstraints,
} from "@bunaway/plugin-api/native";

export const DEFAULT_DPI = 96;

/** Convert a 96-DPI logical dimension to physical pixels for the target DPI. */
export function physicalPixels(logicalPixels: number, dpi: number) {
  return Math.round((logicalPixels * dpi) / DEFAULT_DPI);
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
