import { expect } from "bun:test";
import { inflateSync } from "node:zlib";

/** Decode an opaque 8-bit RGB PNG with Sub filters back to its raw RGB bytes. */
export function decodePng(png: Buffer) {
  expect(png.subarray(0, 8)).toEqual(
    Buffer.from([
      0x89,
      0x50,
      0x4e,
      0x47,
      0x0d,
      0x0a,
      0x1a,
      0x0a,
    ]),
  );
  const chunks = new Map<string, Buffer>();
  for (let offset = 8; offset < png.length; ) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    chunks.set(type, png.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  const header = chunks.get("IHDR") as Buffer;
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  expect([
    header[8],
    header[9],
  ]).toEqual([
    8,
    2,
  ]);
  const raw = inflateSync(chunks.get("IDAT") as Buffer);
  const rgb = Buffer.alloc(width * height * 3);
  for (let row = 0; row < height; row += 1) {
    expect(raw[row * (width * 3 + 1)]).toBe(1);
    for (let at = 0; at < width * 3; at += 1) {
      const left = at >= 3 ? (rgb[row * width * 3 + at - 3] ?? 0) : 0;
      rgb[row * width * 3 + at] =
        ((raw[row * (width * 3 + 1) + 1 + at] ?? 0) + left) & 0xff;
    }
  }
  return {
    width,
    height,
    rgb,
    chunks,
  };
}
