import {
  clampWindowSize,
  type WindowSizeConstraints,
} from "../../../packages/plugin-api/src/native.ts";

export const DEFAULT_DPI = 96;

export function physicalPixels(logicalPixels: number, dpi: number) {
  return Math.round((logicalPixels * dpi) / DEFAULT_DPI);
}

export function logicalPixels(physicalPixels: number, dpi: number) {
  return Math.round((physicalPixels * DEFAULT_DPI) / dpi);
}

// WINDOWPOS already contains the target monitor's physical maximized size.
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
