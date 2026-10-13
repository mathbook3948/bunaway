import { BunawayError } from "@bunaway/protocol";
import { MAX_IMAGE_BYTES } from "./contract.ts";
import type { Pixels } from "./resources.ts";

/** Copy a positive in-bounds pixel rectangle, preserving row order, alpha and source ownership. */
export function cropPixels(
  source: Pixels,
  rectangle: {
    x: number;
    y: number;
    width: number;
    height: number;
  },
): Pixels {
  const { x, y, width, height } = rectangle;
  if (
    ![
      x,
      y,
      width,
      height,
    ].every(Number.isInteger) ||
    x < 0 ||
    y < 0 ||
    width < 1 ||
    height < 1 ||
    x + width > source.width ||
    y + height > source.height ||
    width * height * 4 > MAX_IMAGE_BYTES
  ) {
    throw new BunawayError({
      code: "INVALID_ARGUMENT",
      message:
        "Crop rectangle is outside the image or exceeds the pixel limit.",
    });
  }
  const rowBytes = width * 4;
  const rgba = Buffer.alloc(rowBytes * height);
  for (let row = 0; row < height; row++) {
    const start = ((y + row) * source.width + x) * 4;
    source.rgba.copy(rgba, row * rowBytes, start, start + rowBytes);
  }
  return {
    width,
    height,
    rgba,
  };
}
