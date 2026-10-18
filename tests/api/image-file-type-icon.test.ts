import { expect, test } from "bun:test";
import image from "@bunaway/plugin-image";
import { type JsonValue, NativeRegistry } from "@bunaway/protocol";
import {
  FILE_TYPE_ICON_PIXELS,
  type FileTypeIconSource,
  type ImageCodec,
  type Pixels,
} from "#plugins/image/src/contract";
import {
  imageOperations,
  validateImageInput,
} from "#plugins/image/src/operations";
import { ImagePlatform } from "#plugins/image/src/platforms/image-platform";
import { pluginParsers } from "../fixtures/plugin-parsers.ts";

const parsers = pluginParsers("image", imageOperations);
const registry = new NativeRegistry([
  image._definition,
]);
// Icon creation never decodes or encodes, so only dispose may be reached.
const unusedCodec = new Proxy({} as ImageCodec, {
  get: (_target, name) => () => {
    if (name === "dispose") {
      return;
    }
    throw new Error(`Unexpected codec call: ${String(name)}`);
  },
});

test("file type icon input accepts only a bare extension and a known size", async () => {
  for (const extension of [
    ".txt",
    ".PNG",
    ".tar-gz",
    ".c++",
    ".a_b~1",
    `.${"a".repeat(31)}`,
  ]) {
    expect(
      validateImageInput("image.createFileTypeIcon", {
        extension,
        size: "normal",
      }),
    ).toEqual({
      extension,
      size: "normal",
    });
  }
  for (const size of Object.keys(FILE_TYPE_ICON_PIXELS)) {
    expect(
      (
        await parsers.validateCall({
          operation: "image.createFileTypeIcon",
          payload: {
            extension: ".txt",
            size,
          },
        })
      ).payload,
    ).toEqual({
      extension: ".txt",
      size,
    });
  }
});

test("file type icon input rejects paths, device names, odd characters and unknown shapes", async () => {
  const invalid: JsonValue[] = [
    {
      extension: "txt",
      size: "small",
    },
    {
      extension: ".",
      size: "small",
    },
    {
      extension: "",
      size: "small",
    },
    {
      extension: `.${"a".repeat(32)}`,
      size: "small",
    },
    {
      extension: "file.txt",
      size: "small",
    },
    {
      extension: ".tar.gz",
      size: "small",
    },
    {
      extension: "C:\\dir\\file.txt",
      size: "small",
    },
    {
      extension: "\\\\server\\share\\a.txt",
      size: "small",
    },
    {
      extension: "/a.txt",
      size: "small",
    },
    {
      extension: ".txt/",
      size: "small",
    },
    {
      extension: ".a\\b",
      size: "small",
    },
    {
      extension: ".txt:stream",
      size: "small",
    },
    {
      extension: ".tx t",
      size: "small",
    },
    {
      extension: ".txt ",
      size: "small",
    },
    {
      extension: ".txt\n",
      size: "small",
    },
    {
      extension: ".tx\0t",
      size: "small",
    },
    {
      extension: ".tx*",
      size: "small",
    },
    {
      extension: ".é",
      size: "small",
    },
    {
      extension: 1,
      size: "small",
    },
    {
      extension: ".txt",
      size: "huge",
    },
    {
      extension: ".txt",
      size: 32,
    },
    {
      extension: ".txt",
    },
    {
      size: "small",
    },
    {
      extension: ".txt",
      size: "small",
      path: "C:\\a.txt",
    },
  ];
  for (const payload of invalid) {
    await expect(
      parsers.validateCall({
        operation: "image.createFileTypeIcon",
        payload,
      }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  }
});

test("file type icon creation has its own operation permission", () => {
  const call = {
    operation: "image.createFileTypeIcon",
    payload: null,
  };
  expect(
    registry.allowed(
      {
        permissions: [
          "image.createRGBA",
          "image.resize",
        ],
      },
      call,
    ),
  ).toBe(false);
  expect(
    registry.allowed(
      {
        permissions: [
          "image.createFileTypeIcon",
        ],
      },
      call,
    ),
  ).toBe(true);
});

test("a platform without a file type icon source reports UNSUPPORTED", () => {
  const platform = new ImagePlatform(unusedCodec);
  expect(() =>
    platform.createFileTypeIcon({
      extension: ".txt",
      size: "small",
    }),
  ).toThrow(
    expect.objectContaining({
      code: "UNSUPPORTED",
    }),
  );
});

test("file type icon pixels become a quota-bound resource that dispose releases", () => {
  let disposed = 0;
  const source: FileTypeIconSource = {
    render(_extension, size): Pixels {
      const edge = FILE_TYPE_ICON_PIXELS[size];
      return {
        width: edge,
        height: edge,
        rgba: Buffer.alloc(edge * edge * 4, 255),
      };
    },
    dispose() {
      disposed++;
    },
  };
  const platform = new ImagePlatform(unusedCodec, source);
  const created = platform.createFileTypeIcon({
    extension: ".txt",
    size: "large",
  });
  expect(created).toMatchObject({
    width: 48,
    height: 48,
    empty: false,
  });
  expect(platform.getInfo(created.id)).toEqual({
    width: 48,
    height: 48,
    empty: false,
  });
  expect(platform.remove(created.id)).toBe(true);
  expect(() => platform.getInfo(created.id)).toThrow(
    expect.objectContaining({
      code: "INVALID_ARGUMENT",
    }),
  );
  platform.dispose();
  platform.dispose();
  expect(disposed).toBe(1);
});

test("an aborted file type icon request creates no resource", () => {
  const platform = new ImagePlatform(unusedCodec, {
    render: () => ({
      width: 1,
      height: 1,
      rgba: Buffer.alloc(4),
    }),
    dispose() {},
  });
  const controller = new AbortController();
  controller.abort();
  expect(() =>
    platform.createFileTypeIcon(
      {
        extension: ".txt",
        size: "small",
      },
      controller.signal,
    ),
  ).toThrow(
    expect.objectContaining({
      code: "CANCELLED",
    }),
  );
});
