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
const RGBA_BYTES_PER_PIXEL = 4;
const COLOR_TYPE_RGBA = 6;
const BIT_DEPTH = 8;
const FILTER_NONE = 0;
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
 * Encode straight (non-premultiplied) RGBA rows as an 8-bit PNG with an alpha channel. Icons are
 * small, so every row is stored unfiltered and compression alone keeps the result short.
 */
export function encodeRgbaPng(
  rgba: Uint8Array,
  width: number,
  height: number,
): Buffer {
  const rowBytes = width * RGBA_BYTES_PER_PIXEL;
  const raw = Buffer.alloc((rowBytes + 1) * height);
  for (let row = 0; row < height; row += 1) {
    const target = row * (rowBytes + 1);
    raw[target] = FILTER_NONE;
    raw.set(rgba.subarray(row * rowBytes, (row + 1) * rowBytes), target + 1);
  }
  const header = Buffer.alloc(IHDR_BYTES);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = BIT_DEPTH;
  header[9] = COLOR_TYPE_RGBA;
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
