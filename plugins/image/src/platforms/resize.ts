import { BunawayError } from "@bunaway/protocol";
import { MAX_IMAGE_BYTES, type Pixels } from "#image/contract";
/** Require a nonempty source and a bounded positive output before allocating resize pixels. */
export function assertResizeDimensions(
  source: Pixels,
  width: number,
  height: number,
): void {
  if (
    source.width === 0 ||
    source.height === 0 ||
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    width > 4096 ||
    height < 1 ||
    height > 4096 ||
    width * height * 4 > MAX_IMAGE_BYTES
  ) {
    throw new BunawayError({
      code: "INVALID_ARGUMENT",
      message:
        "Resize requires a nonempty source and bounded positive dimensions.",
    });
  }
}

/** Sample each output pixel's center and copy all four straight RGBA bytes without alpha conversion. */
export function resizeNearestPixels(
  source: Pixels,
  width: number,
  height: number,
): Pixels {
  assertResizeDimensions(source, width, height);
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const sourceY = Math.floor(((y + 0.5) * source.height) / height);
    for (let x = 0; x < width; x++) {
      const sourceX = Math.floor(((x + 0.5) * source.width) / width);
      const start = (sourceY * source.width + sourceX) * 4;
      source.rgba.copy(rgba, (y * width + x) * 4, start, start + 4);
    }
  }
  return {
    width,
    height,
    rgba,
  };
}
