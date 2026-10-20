import { ptr } from "bun:ffi";
import { expect, test } from "bun:test";
import type { JsonValue } from "@bunaway/protocol";
import { Objc } from "#native/macos/bun/objc";
import type { ClipboardItem } from "#plugins/clipboard/src/contract";
import {
  MAX_IMAGE_BYTES,
  MAX_TEXT_LENGTH,
} from "#plugins/clipboard/src/contract";
import { createPasteboard } from "#plugins/clipboard/src/platforms/macos-pasteboard";
import {
  encodeTIFF,
  MAX_TIFF_BYTES,
} from "#plugins/clipboard/src/platforms/macos-tiff";
import { pasteboardOperations } from "../fixtures/injected-native-plugins.ts";

test.skipIf(
  process.platform !== "darwin" || process.env.BUNAWAY_CLIPBOARD_NATIVE !== "1",
)(
  "real NSPasteboard Unicode, multi-format, bounded RGBA and cleanup on a unique fixture board",
  async () => {
    const name = `tests.bunaway.clipboard.${crypto.randomUUID()}`;
    const native = createPasteboard(name);
    const observer = createPasteboard(name);
    const objc = new Objc();
    const externalData = (bytes: Buffer) =>
      objc.send(
        objc.class("NSData"),
        "dataWithBytes:length:",
        ptr(bytes),
        bytes.length,
      );
    const installExternal = (type: string, bytes: Buffer) =>
      objc.withAutoreleasePool(() => {
        const board = objc.send(
          objc.class("NSPasteboard"),
          "pasteboardWithName:",
          objc.string(name),
        );
        objc.send(board, "clearContents");
        expect(
          Number(
            objc.send(
              board,
              "setData:forType:",
              externalData(bytes),
              objc.string(type),
            ),
          ),
        ).toBe(1);
      });
    const adapter = pasteboardOperations(native);
    const invoke = (
      operation: string,
      input: JsonValue,
      permissions = [
        operation,
      ],
    ) =>
      adapter.executeUI?.(operation, input, "backend", {
        requestId: "native",
        permissions: {
          permissions,
        },
      });
    try {
      native.clear();
      expect(await invoke("clipboard.readText", null)).toBeNull();
      expect(await invoke("clipboard.getFormats", null)).toEqual([]);
      for (const text of [
        "",
        "한글 😀\n\r\n",
        "😀".repeat(MAX_TEXT_LENGTH),
      ]) {
        expect(
          await invoke("clipboard.writeText", {
            text,
          }),
        ).toBeNull();
        expect(await invoke("clipboard.readText", null)).toBe(text);
        expect(observer.read("text/plain").data).toBe(text);
      }
      const image = {
        width: 2,
        height: 2,
        rgba: Buffer.from([
          255,
          0,
          0,
          128,
          0,
          255,
          0,
          255,
          5,
          7,
          11,
          0,
          0,
          0,
          255,
          1,
        ]).toString("base64"),
      };
      const items: ClipboardItem[] = [
        {
          format: "text/plain",
          data: "fallback 한글 😀",
        },
        {
          format: "text/html",
          data: "<p>한글 😀</p>",
        },
        {
          format: "text/rtf",
          data: "{\\rtf1 \\u54620?}",
        },
        {
          format: "image/bmp",
          data: image,
        },
      ];
      await invoke("clipboard.writeFormats", {
        items,
      });
      expect(await invoke("clipboard.getFormats", null)).toEqual(
        items.map((item) => item.format),
      );
      expect(
        await invoke("clipboard.readFormats", {
          formats: items.map((item) => item.format),
        }),
      ).toEqual(items);
      expect(observer.read("image/bmp").data).toEqual(image);
      // AppKit independently decodes the TIFF, so the pixel codec is not its own oracle.
      objc.withAutoreleasePool(() => {
        const rep = objc.send(
          objc.class("NSBitmapImageRep"),
          "imageRepWithData:",
          externalData(encodeTIFF(image)),
        );
        expect(rep).not.toBeNull();
        expect(Number(objc.send(rep, "pixelsWide"))).toBe(image.width);
        expect(Number(objc.send(rep, "pixelsHigh"))).toBe(image.height);
        expect(Number(objc.send(rep, "bitsPerSample"))).toBe(8);
        expect(Number(objc.send(rep, "samplesPerPixel"))).toBe(4);
      });
      await expect(invoke("clipboard.clear", null, [])).rejects.toThrow(
        expect.objectContaining({
          code: "PERMISSION_DENIED",
        }),
      );
      expect(observer.read("text/plain").data).toBe("fallback 한글 😀");
      // A Windows path is rejected by the macOS contract before the board changes.
      await expect(
        invoke("clipboard.writeFormats", {
          items: [
            {
              format: "application/x-bunaway-file-list",
              data: [
                "C:\\memo.txt",
              ],
            },
          ],
        }),
      ).rejects.toThrow(
        expect.objectContaining({
          code: "INVALID_ARGUMENT",
        }),
      );
      expect(observer.read("text/plain").data).toBe("fallback 한글 😀");
      expect(
        await invoke("clipboard.hasFormat", {
          format: "application/x-bunaway-file-list",
        }),
      ).toBe(false);
      expect(
        await invoke("clipboard.readFormats", {
          formats: [
            "application/x-bunaway-file-list",
          ],
        }),
      ).toEqual([
        {
          format: "application/x-bunaway-file-list",
          data: null,
        },
      ]);
      // Several files become one pasteboard item each, with the text kept on the first.
      const files = [
        "/tmp/bunaway clipboard/한글 😀 #1.txt",
        "/tmp/bunaway clipboard/100%.txt",
        "/tmp/../tmp/dir",
      ];
      const fileItems: ClipboardItem[] = [
        {
          format: "text/plain",
          data: "with files",
        },
        {
          format: "application/x-bunaway-file-list",
          data: files,
        },
      ];
      await invoke("clipboard.writeFormats", {
        items: fileItems,
      });
      expect(await invoke("clipboard.getFormats", null)).toEqual([
        "text/plain",
        "application/x-bunaway-file-list",
      ]);
      expect(
        await invoke("clipboard.readFormats", {
          formats: fileItems.map((item) => item.format),
        }),
      ).toEqual(fileItems);
      expect(observer.read("application/x-bunaway-file-list").data).toEqual(
        files,
      );
      // AppKit independently reads each written URL back as a file path.
      objc.withAutoreleasePool(() => {
        const board = objc.send(
          objc.class("NSPasteboard"),
          "pasteboardWithName:",
          objc.string(name),
        );
        const urls = objc.send(
          board,
          "readObjectsForClasses:options:",
          objc.send(
            objc.class("NSArray"),
            "arrayWithObject:",
            objc.class("NSURL"),
          ),
          null,
        );
        expect(Number(objc.send(urls, "count"))).toBe(files.length);
        expect(
          objc.text(objc.send(objc.send(urls, "objectAtIndex:", 0), "path")),
        ).toBe(files[0] ?? "");
      });
      // Finder-style directory URLs, file reference URLs and remote hosts.
      installExternal(
        "public.file-url",
        Buffer.from("file://localhost/Users/me/My%20Dir/"),
      );
      expect(
        await invoke("clipboard.readFormats", {
          formats: [
            "application/x-bunaway-file-list",
          ],
        }),
      ).toEqual([
        {
          format: "application/x-bunaway-file-list",
          data: [
            "/Users/me/My Dir",
          ],
        },
      ]);
      for (const url of [
        "file:///.file/id=6571367.9114570",
        "file://server/share/file",
      ]) {
        installExternal("public.file-url", Buffer.from(url));
        expect(
          await invoke("clipboard.readFormats", {
            formats: [
              "application/x-bunaway-file-list",
            ],
          }),
        ).toEqual([
          {
            format: "application/x-bunaway-file-list",
            data: null,
          },
        ]);
      }
      installExternal("public.file-url", Buffer.from("file:///bad%ZZ"));
      await expect(
        invoke("clipboard.readFormats", {
          formats: [
            "application/x-bunaway-file-list",
          ],
        }),
      ).rejects.toThrow();
      await invoke("clipboard.writeText", {
        text: "fallback 한글 😀",
      });
      for (const item of [
        {
          format: "application/x-bunaway-bookmark",
          data: {
            url: "https://example.com/",
          },
        },
        {
          format: "application/x-bunaway-binary/macos-fixture",
          data: "AA==",
        },
      ] as const) {
        await expect(
          invoke("clipboard.writeFormats", {
            items: [
              {
                format: "text/plain",
                data: "prepared",
              },
              item,
            ],
          }),
        ).rejects.toThrow(
          expect.objectContaining({
            code: "UNSUPPORTED",
          }),
        );
        expect(observer.read("text/plain").data).toBe("fallback 한글 😀");
        expect(
          await invoke("clipboard.hasFormat", {
            format: item.format,
          }),
        ).toBe(false);
        expect(
          await invoke("clipboard.readFormats", {
            formats: [
              item.format,
            ],
          }),
        ).toEqual([
          {
            format: item.format,
            data: null,
          },
        ]);
      }
      const maximum = {
        width: 512,
        height: 256,
        rgba: Buffer.alloc(MAX_IMAGE_BYTES, 17).toString("base64"),
      };
      await invoke("clipboard.writeImage", maximum);
      expect(await invoke("clipboard.readImage", null)).toEqual(maximum);
      expect(await invoke("clipboard.readText", null)).toBeNull();
      expect(
        await invoke("clipboard.hasFormat", {
          format: "text/html",
        }),
      ).toBe(false);
      expect(
        await invoke("clipboard.readFormats", {
          formats: [
            "text/plain",
            "text/html",
            "text/rtf",
          ],
        }),
      ).toEqual(
        [
          "text/plain",
          "text/html",
          "text/rtf",
        ].map((format) => ({
          format,
          data: null,
        })),
      );
      await expect(
        invoke("clipboard.writeText", {
          text: "x".repeat(MAX_TEXT_LENGTH + 1),
        }),
      ).rejects.toThrow(
        expect.objectContaining({
          code: "INVALID_ARGUMENT",
        }),
      );
      expect(await invoke("clipboard.readImage", null)).toEqual(maximum);
      await invoke("clipboard.clear", null);
      expect(await invoke("clipboard.readImage", null)).toBeNull();
      for (const [type, bytes, operation] of [
        [
          "public.utf8-plain-text",
          Buffer.from("é".repeat(MAX_TEXT_LENGTH + 1)),
          "clipboard.readText",
        ],
        [
          "public.utf8-plain-text",
          Buffer.from([
            0xc0,
            0xaf,
          ]),
          "clipboard.readText",
        ],
        [
          "public.utf8-plain-text",
          Buffer.from("x\0y"),
          "clipboard.readText",
        ],
        [
          "public.tiff",
          Buffer.alloc(MAX_TIFF_BYTES + 1),
          "clipboard.readImage",
        ],
        [
          "public.tiff",
          Buffer.from("not a TIFF"),
          "clipboard.readImage",
        ],
      ] as const) {
        installExternal(type, bytes);
        await expect(invoke(operation, null)).rejects.toThrow(
          expect.objectContaining({
            code: "INTERNAL",
          }),
        );
      }
      installExternal("tests.bunaway.unknown", Buffer.from("unknown data"));
      expect(await invoke("clipboard.readText", null)).toBeNull();
      expect(await invoke("clipboard.getFormats", null)).toEqual([]);
      await adapter.dispose();
      await adapter.dispose();
      await expect(invoke("clipboard.clear", null)).rejects.toThrow(
        expect.objectContaining({
          code: "CANCELLED",
        }),
      );
    } finally {
      await adapter.dispose();
      observer.dispose();
    }
  },
);
