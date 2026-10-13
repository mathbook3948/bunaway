import { deflateSync } from "node:zlib";

/** Small opaque BGRA ICO fixture with a conventional doubled-height DIB and AND mask. */
export function trayIco(size = 16): Buffer {
  const imageBytes = size * size * 4;
  const maskBytes = Math.ceil(size / 32) * 4 * size;
  const dib = Buffer.alloc(40 + imageBytes + maskBytes);
  dib.writeUInt32LE(40, 0);
  dib.writeInt32LE(size, 4);
  dib.writeInt32LE(size * 2, 8);
  dib.writeUInt16LE(1, 12);
  dib.writeUInt16LE(32, 14);
  dib.writeUInt32LE(imageBytes, 20);
  for (let offset = 40; offset < 40 + imageBytes; offset += 4) {
    dib[offset] = 32;
    dib[offset + 1] = 96;
    dib[offset + 2] = 200;
    dib[offset + 3] = 255;
  }
  const header = Buffer.alloc(22);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  header[6] = size;
  header[7] = size;
  header.writeUInt16LE(1, 10);
  header.writeUInt16LE(32, 12);
  header.writeUInt32LE(dib.length, 14);
  header.writeUInt32LE(22, 18);
  return Buffer.concat([
    header,
    dib,
  ]);
}

/** Real 1x1 RGBA PNG frame inside an ICO directory, including chunk CRCs. */
export function trayPngIco(): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const name = Buffer.from(type, "ascii");
    const input = Buffer.concat([
      name,
      data,
    ]);
    let crc = 0xffffffff;
    for (const byte of input) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) {
        crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
      }
    }
    const result = Buffer.alloc(12 + data.length);
    result.writeUInt32BE(data.length, 0);
    input.copy(result, 4);
    result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4);
    return result;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const png = Buffer.concat([
    Buffer.from([
      137,
      80,
      78,
      71,
      13,
      10,
      26,
      10,
    ]),
    chunk("IHDR", ihdr),
    chunk(
      "IDAT",
      deflateSync(
        Buffer.from([
          0,
          200,
          96,
          32,
          255,
        ]),
      ),
    ),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  const header = Buffer.alloc(22);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  header[6] = 1;
  header[7] = 1;
  header.writeUInt16LE(1, 10);
  header.writeUInt16LE(32, 12);
  header.writeUInt32LE(png.length, 14);
  header.writeUInt32LE(22, 18);
  return Buffer.concat([
    header,
    png,
  ]);
}
