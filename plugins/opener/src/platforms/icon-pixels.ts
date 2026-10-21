/** Raster of one icon: straight (non-premultiplied) RGBA rows, top row first. */
export type IconPixels = {
  width: number;
  height: number;
  rgba: Buffer;
};

const BYTES_PER_PIXEL = 4;
const OPAQUE_ALPHA = 0xff;

/** Whether any BGRA pixel carries a non-zero alpha value. */
export function hasAlphaChannel(bgra: Buffer): boolean {
  for (let offset = 3; offset < bgra.length; offset += BYTES_PER_PIXEL) {
    if (bgra[offset] !== 0) {
      return true;
    }
  }
  return false;
}

/**
 * Convert BGRA to straight RGBA. An icon with an alpha channel keeps it. An older icon without one
 * is opaque except where its AND mask (expanded to 32 bits per pixel) is non-zero: those pixels
 * stay fully transparent.
 */
export function toRgba(bgra: Buffer, andMask?: Buffer): Buffer {
  const hasAlpha = andMask === undefined && hasAlphaChannel(bgra);
  const rgba = Buffer.alloc(bgra.length);
  for (let offset = 0; offset < bgra.length; offset += BYTES_PER_PIXEL) {
    if (andMask && andMask[offset] !== 0) {
      continue;
    }
    rgba[offset] = bgra[offset + 2] ?? 0;
    rgba[offset + 1] = bgra[offset + 1] ?? 0;
    rgba[offset + 2] = bgra[offset] ?? 0;
    rgba[offset + 3] = hasAlpha ? (bgra[offset + 3] ?? 0) : OPAQUE_ALPHA;
  }
  return rgba;
}
