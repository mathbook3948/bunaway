import { crc32, deflateSync } from "node:zlib";

/** The eight bytes every PNG file starts with. */
const SIGNATURE = Buffer.from([
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
]);
const BYTES_PER_RGBA_PIXEL = 4;

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([
    Buffer.from(type, "ascii"),
    data,
  ]);
  const result = Buffer.alloc(body.length + 8);
  result.writeUInt32BE(data.length, 0);
  body.copy(result, 4);
  result.writeUInt32BE(crc32(body), result.length - 4);
  return result;
}

/** A valid opaque RGBA PNG of one color, large enough in pixels to be a menu bar image at 1x or 2x. */
export function solidPng(width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const row = Buffer.alloc(1 + width * BYTES_PER_RGBA_PIXEL, 0x80);
  row[0] = 0;
  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", header),
    chunk(
      "IDAT",
      deflateSync(
        Buffer.concat(
          Array.from(
            {
              length: height,
            },
            () => row,
          ),
        ),
      ),
    ),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A PNG header only: enough for size validation, not decodable. */
export function headerOnlyPng(width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", header),
  ]);
}
