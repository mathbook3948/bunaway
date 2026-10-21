import { expect, test } from "bun:test";
import { inflateSync } from "node:zlib";
import opener from "@bunaway/plugin-opener";
import { NativeRegistry } from "@bunaway/protocol";
import { createOpener } from "#plugins/opener/src/calls";
import {
  fileIconSchema,
  MAX_FILE_ICON_EDGE_PIXELS,
  validateOpenerInput,
} from "#plugins/opener/src/contract";
import {
  macosOperations,
  windowsOperations,
} from "#plugins/opener/src/operations";
import {
  hasAlphaChannel,
  toRgba,
} from "#plugins/opener/src/platforms/icon-pixels";
import { encodeRgbaPng } from "#plugins/opener/src/platforms/rgba-png";
import { normalizeFileIconExtension } from "#plugins/opener/src/platforms/windows-path";
import { pluginParsers } from "../fixtures/plugin-parsers.ts";

const parsers = pluginParsers("opener", windowsOperations);
const registry = new NativeRegistry([
  opener._definition,
]);

function invalid(input: unknown) {
  expect(() =>
    validateOpenerInput("opener.getFileIcon", input as never),
  ).toThrow(
    expect.objectContaining({
      code: "INVALID_ARGUMENT",
    }),
  );
}

test("getFileIcon takes a path or an extension and an optional size", () => {
  expect(
    validateOpenerInput("opener.getFileIcon", {
      path: "C:\\Windows\\notepad.exe",
    }),
  ).toEqual({
    path: "C:\\Windows\\notepad.exe",
  });
  expect(
    validateOpenerInput("opener.getFileIcon", {
      extension: ".txt",
      size: "large",
    }),
  ).toEqual({
    extension: ".txt",
    size: "large",
  });
  expect(
    validateOpenerInput("opener.getFileIcon", {
      path: "C:\\a.txt",
      size: "small",
    }),
  ).toEqual({
    path: "C:\\a.txt",
    size: "small",
  });
});

test("getFileIcon rejects a missing target, both targets and unknown fields", () => {
  invalid({});
  invalid({
    size: "small",
  });
  invalid({
    path: "C:\\a.txt",
    extension: ".txt",
  });
  invalid({
    extension: ".txt",
    extra: 1,
  });
  invalid({
    path: "C:\\a.txt",
    size: "huge",
  });
  invalid({
    path: "C:\\a.txt",
    size: 32,
  });
});

test("getFileIcon accepts only a plain extension", () => {
  for (const extension of [
    ".txt",
    ".C++",
    ".tar-gz",
    ".a_b~1",
    `.${"x".repeat(31)}`,
  ]) {
    expect(
      validateOpenerInput("opener.getFileIcon", {
        extension,
      }),
    ).toEqual({
      extension,
    });
  }
  for (const extension of [
    "",
    ".",
    "txt",
    ".tar.gz",
    ".a b",
    ".a/b",
    ".a\\b",
    ".a:b",
    ".a\0b",
    ".*",
    `.${"x".repeat(32)}`,
    "file.txt",
    "C:\\a.txt",
    1,
  ]) {
    invalid({
      extension,
    });
  }
});

test("the client rejects a bad extension before calling the host", () => {
  expect(normalizeFileIconExtension(".txt")).toBe(".txt");
  expect(() => normalizeFileIconExtension("txt")).toThrow(
    expect.objectContaining({
      code: "INVALID_ARGUMENT",
    }),
  );
});

test("getFileIcon returns a bounded PNG with its pixel size", () => {
  const output = windowsOperations.getFileIcon.output;
  const png = encodeRgbaPng(new Uint8Array(4 * 4), 2, 2).toString("base64");
  expect(
    output.parse({
      mime: "image/png",
      data: png,
      width: 2,
      height: 2,
    }),
  ).toEqual({
    mime: "image/png",
    data: png,
    width: 2,
    height: 2,
  });
  for (const bad of [
    {
      mime: "image/jpeg",
      data: png,
      width: 2,
      height: 2,
    },
    {
      mime: "image/png",
      data: png,
      width: 0,
      height: 2,
    },
    {
      mime: "image/png",
      data: png,
      width: MAX_FILE_ICON_EDGE_PIXELS + 1,
      height: 2,
    },
    {
      mime: "image/png",
      data: "not base64!",
      width: 2,
      height: 2,
    },
    {
      mime: "image/png",
      data: Buffer.alloc(512 * 1024 + 1).toString("base64"),
      width: 2,
      height: 2,
    },
    {
      mime: "image/png",
      data: png,
      width: 2,
      height: 2,
      extra: true,
    },
  ]) {
    expect(fileIconSchema.safeParse(bad).success).toBe(false);
  }
});

test("encodeRgbaPng writes straight RGBA rows with an alpha channel", () => {
  const rgba = Uint8Array.from([
    255,
    0,
    0,
    255,
    0,
    255,
    0,
    128,
    0,
    0,
    255,
    0,
    10,
    20,
    30,
    40,
  ]);
  const png = encodeRgbaPng(rgba, 2, 2);
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
  // IHDR: 13 data bytes after the 8-byte signature and the 8-byte chunk header.
  const header = png.subarray(16, 29);
  expect(header.readUInt32BE(0)).toBe(2);
  expect(header.readUInt32BE(4)).toBe(2);
  expect(header[8]).toBe(8);
  expect(header[9]).toBe(6);
  const idatLength = png.readUInt32BE(33);
  expect(png.subarray(37, 41).toString("ascii")).toBe("IDAT");
  const raw = inflateSync(png.subarray(41, 41 + idatLength));
  expect(raw).toEqual(
    Buffer.from([
      0,
      255,
      0,
      0,
      255,
      0,
      255,
      0,
      128,
      0,
      0,
      0,
      255,
      0,
      10,
      20,
      30,
      40,
    ]),
  );
  expect(png.subarray(-8, -4).toString("ascii")).toBe("IEND");
});

test("getFileIcon has its own permission", async () => {
  const call = await parsers.validateCall({
    operation: "opener.getFileIcon",
    payload: {
      extension: ".txt",
    },
  });
  expect(
    registry.allowed(
      {
        permissions: [
          "opener.getFileIcon",
        ],
      },
      call,
    ),
  ).toBe(true);
  for (const other of [
    "opener.openFile",
    "opener.readShortcutLink",
    "image.createFileTypeIcon",
  ]) {
    expect(
      registry.allowed(
        {
          permissions: [
            other,
          ],
        },
        call,
      ),
    ).toBe(false);
  }
});

test("macOS does not declare getFileIcon", () => {
  expect("getFileIcon" in macosOperations).toBe(false);
});

test("the client rejects a path and an extension given together", async () => {
  const sent: unknown[] = [];
  const client = createOpener({
    getFileIcon: async (input: unknown) => {
      sent.push(input);
      return null;
    },
  } as never);
  await expect(
    client.getFileIcon({
      path: "C:\\a.txt",
      extension: ".txt",
    } as never),
  ).rejects.toThrow(
    expect.objectContaining({
      code: "INVALID_ARGUMENT",
    }),
  );
  await expect(client.getFileIcon({} as never)).rejects.toThrow(
    expect.objectContaining({
      code: "INVALID_ARGUMENT",
    }),
  );
  expect(sent).toEqual([]);
});

test("icon pixels become straight RGBA and use the AND mask only without alpha", () => {
  const withAlpha = Buffer.from([
    10,
    20,
    30,
    128,
    1,
    2,
    3,
    0,
  ]);
  expect(hasAlphaChannel(withAlpha)).toBe(true);
  expect(toRgba(withAlpha)).toEqual(
    Buffer.from([
      30,
      20,
      10,
      128,
      3,
      2,
      1,
      0,
    ]),
  );
  const noAlpha = Buffer.from([
    10,
    20,
    30,
    0,
    40,
    50,
    60,
    0,
  ]);
  expect(hasAlphaChannel(noAlpha)).toBe(false);
  expect(toRgba(noAlpha)).toEqual(
    Buffer.from([
      30,
      20,
      10,
      255,
      60,
      50,
      40,
      255,
    ]),
  );
  // A non-zero mask byte marks a transparent pixel, which stays all zero.
  const mask = Buffer.from([
    0,
    0,
    0,
    0,
    255,
    255,
    255,
    0,
  ]);
  expect(toRgba(noAlpha, mask)).toEqual(
    Buffer.from([
      30,
      20,
      10,
      255,
      0,
      0,
      0,
      0,
    ]),
  );
});
