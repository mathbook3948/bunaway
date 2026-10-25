import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { BunawayError } from "@bunaway/protocol";
import {
  MAX_IMAGE_BYTES,
  MAX_SOURCE_DIMENSION,
  MAX_SOURCE_FILE_BYTES,
} from "#plugins/image/src/contract";
import { dispose, initialize } from "#plugins/image/src/platforms/windows";

type Rgba = [
  number,
  number,
  number,
  number,
];

/** Encode a single-color 8-bit RGBA PNG; each row is one filter byte followed by repeated pixels. */
function solidPng(width: number, height: number, color: Rgba): Buffer {
  const row = Buffer.alloc(1 + width * 4);
  for (let x = 0; x < width; x++) {
    row.set(color, 1 + x * 4);
  }
  const raw = Buffer.concat(
    Array.from(
      {
        length: height,
      },
      () => row,
    ),
  );
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "ascii");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(
      crc32(
        Buffer.concat([
          head.subarray(4),
          data,
        ]),
      ),
      0,
    );
    return Buffer.concat([
      head,
      data,
      crc,
    ]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set(
    [
      8,
      6,
      0,
      0,
      0,
    ],
    8,
  );
  return Buffer.concat([
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
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function codeOf(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    return error instanceof BunawayError ? error.code : String(error);
  }
  return "no error";
}

/** Real WIC and file system: scaling happens while decoding, and unsafe files are refused before decoding. */
test.skipIf(process.platform !== "win32")(
  "createFromPath decodes image files scaled to the requested and resource limits",
  () => {
    const root = mkdtempSync(join(tmpdir(), "bunaway-image-file-"));
    const platform = initialize();
    try {
      const write = (name: string, bytes: Buffer) => {
        const path = join(root, name);
        writeFileSync(path, bytes);
        return path;
      };
      // A file larger than the image edge limit shrinks to the resource pixel limit by default.
      const wide = write(
        "wide.png",
        solidPng(
          5000,
          2000,
          [
            255,
            0,
            0,
            255,
          ],
        ),
      );
      const fitted = platform.createFromPath({
        path: wide,
      });
      expect(fitted.width * fitted.height * 4).toBeLessThanOrEqual(
        MAX_IMAGE_BYTES,
      );
      expect(fitted.width / fitted.height).toBeCloseTo(2.5, 1);
      const pixels = Buffer.from(platform.getPixels(fitted.id).rgba, "base64");
      expect([
        ...pixels.subarray(0, 4),
      ]).toEqual([
        255,
        0,
        0,
        255,
      ]);

      // maxDimension bounds the longer edge and keeps the aspect ratio.
      const thumbnail = platform.createFromPath({
        path: wide,
        maxDimension: 64,
      });
      expect([
        thumbnail.width,
        thumbnail.height,
      ]).toEqual([
        64,
        25,
      ]);

      // A source within every limit keeps its size, and the extension plays no part.
      const small = write(
        "small.dat",
        solidPng(
          10,
          6,
          [
            0,
            128,
            255,
            255,
          ],
        ),
      );
      const unchanged = platform.createFromPath({
        path: small,
      });
      expect([
        unchanged.width,
        unchanged.height,
      ]).toEqual([
        10,
        6,
      ]);

      // Scaling uses premultiplied alpha, so a translucent color keeps its channels.
      const translucent = write(
        "translucent.png",
        solidPng(
          200,
          200,
          [
            255,
            0,
            0,
            128,
          ],
        ),
      );
      const half = platform.createFromPath({
        path: translucent,
        maxDimension: 100,
      });
      expect([
        half.width,
        half.height,
      ]).toEqual([
        100,
        100,
      ]);
      const halfPixels = Buffer.from(
        platform.getPixels(half.id).rgba,
        "base64",
      );
      const [red = 0, green = 0, blue = 0, alpha = 0] = halfPixels;
      expect(red).toBeGreaterThanOrEqual(253);
      expect(green).toBeLessThanOrEqual(2);
      expect(blue).toBeLessThanOrEqual(2);
      expect(Math.abs(alpha - 128)).toBeLessThanOrEqual(2);

      // JPEG and BMP files are recognized from their content.
      for (const [name, format] of [
        [
          "from-jpeg.bin",
          "image/jpeg",
        ],
        [
          "from-bmp.bin",
          "image/bmp",
        ],
      ] as const) {
        const opaque = platform.createFromPath({
          path: small,
        });
        const encoded = Buffer.from(
          platform.exportBytes({
            id: opaque.id,
            format,
          }).data,
          "base64",
        );
        const decoded = platform.createFromPath({
          path: write(name, encoded),
        });
        expect([
          decoded.width,
          decoded.height,
        ]).toEqual([
          10,
          6,
        ]);
      }

      // Unsafe or unreadable inputs fail before any pixel is decoded.
      expect(
        codeOf(() =>
          platform.createFromPath({
            path: join(root, "none.png"),
          }),
        ),
      ).toBe("INVALID_ARGUMENT");
      const directory = join(root, "folder.png");
      mkdirSync(directory);
      expect(
        codeOf(() =>
          platform.createFromPath({
            path: directory,
          }),
        ),
      ).toBe("INVALID_ARGUMENT");
      const notImage = write("text.png", Buffer.from("not an image at all"));
      expect(
        codeOf(() =>
          platform.createFromPath({
            path: notImage,
          }),
        ),
      ).toBe("INVALID_ARGUMENT");
      const truncated = write("truncated.png", wideHead(wide));
      expect(
        codeOf(() =>
          platform.createFromPath({
            path: truncated,
          }),
        ),
      ).toBe("INVALID_ARGUMENT");
      const huge = write(
        "huge.png",
        Buffer.concat([
          solidPng(
            1,
            1,
            [
              0,
              0,
              0,
              255,
            ],
          ).subarray(0, 8),
          Buffer.alloc(MAX_SOURCE_FILE_BYTES),
        ]),
      );
      expect(
        codeOf(() =>
          platform.createFromPath({
            path: huge,
          }),
        ),
      ).toBe("INVALID_ARGUMENT");
      const tall = write(
        "tall.png",
        solidPng(
          1,
          MAX_SOURCE_DIMENSION + 1,
          [
            0,
            0,
            0,
            255,
          ],
        ),
      );
      expect(
        codeOf(() =>
          platform.createFromPath({
            path: tall,
          }),
        ),
      ).toBe("INVALID_ARGUMENT");
    } finally {
      dispose(platform);
      dispose(platform);
      rmSync(root, {
        recursive: true,
        force: true,
      });
    }
  },
);

/** The first half of an encoded file: a valid header followed by cut pixel data. */
function wideHead(path: string): Buffer {
  const bytes = readFileSync(path);
  return bytes.subarray(0, Math.max(64, bytes.length >> 1));
}
