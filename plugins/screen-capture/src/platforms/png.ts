import { crc32, deflateSync } from "node:zlib";

const PNG_SIGNATURE = Buffer.from([
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
]);
const BITMAP_BYTES_PER_PIXEL = 4;
const RGB_BYTES_PER_PIXEL = 3;
const COLOR_TYPE_RGB = 2;
const BIT_DEPTH = 8;
const FILTER_SUB = 1;
const IHDR_BYTES = 13;
const CHUNK_OVERHEAD_BYTES = 12;

function chunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(data.length + CHUNK_OVERHEAD_BYTES);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  // The checksum covers the type and the data, not the length.
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/**
 * Encode top-down BGRX pixels (the layout of a 32 bpp device-independent bitmap) as an opaque
 * 8-bit RGB PNG. The unused fourth byte is dropped, which also discards the undefined alpha a GDI
 * copy leaves there. Every row uses the Sub filter, which keeps screen content compressible
 * without the cost of choosing a filter per row.
 */
export function encodePng(
  bgrx: Uint8Array,
  width: number,
  height: number,
): Buffer {
  const rowBytes = width * RGB_BYTES_PER_PIXEL;
  const raw = Buffer.alloc((rowBytes + 1) * height);
  for (let row = 0; row < height; row += 1) {
    const source = row * width * BITMAP_BYTES_PER_PIXEL;
    const target = row * (rowBytes + 1);
    raw[target] = FILTER_SUB;
    // Sub stores each byte minus the byte one pixel to its left; the first pixel stores itself.
    for (let column = 0; column < width; column += 1) {
      const pixel = source + column * BITMAP_BYTES_PER_PIXEL;
      const out = target + 1 + column * RGB_BYTES_PER_PIXEL;
      const hasLeft = column > 0;
      const blue = bgrx[pixel] ?? 0;
      const green = bgrx[pixel + 1] ?? 0;
      const red = bgrx[pixel + 2] ?? 0;
      raw[out] = (red - (hasLeft ? (bgrx[pixel - 2] ?? 0) : 0)) & 0xff;
      raw[out + 1] = (green - (hasLeft ? (bgrx[pixel - 3] ?? 0) : 0)) & 0xff;
      raw[out + 2] = (blue - (hasLeft ? (bgrx[pixel - 4] ?? 0) : 0)) & 0xff;
    }
  }
  const header = Buffer.alloc(IHDR_BYTES);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = BIT_DEPTH;
  header[9] = COLOR_TYPE_RGB;
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
