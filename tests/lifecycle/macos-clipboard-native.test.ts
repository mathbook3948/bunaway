import { ptr } from "bun:ffi";
import { expect, test } from "bun:test";
import type { JsonValue } from "@bunaway/protocol";
import { Objc } from "#native/macos/bun/objc";
import type { ClipboardItem } from "#plugins/clipboard/src/formats";
import { MAX_IMAGE_BYTES } from "#plugins/clipboard/src/formats";
import { createPasteboard } from "#plugins/clipboard/src/macos-pasteboard";
import { encodeTIFF, MAX_TIFF_BYTES } from "#plugins/clipboard/src/macos-tiff";
import { pasteboardOperations } from "#plugins/clipboard/src/platforms/macos";
import { MAX_TEXT_LENGTH } from "#plugins/clipboard/src/text";

test.skipIf(
  process.platform !== "darwin" || process.env.BUNAWAY_CLIPBOARD_NATIVE !== "1",
)(
  "real NSPasteboard Unicode, multi-format, bounded RGBA and cleanup on a unique fixture board",
  () => {
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
      expect(invoke("clipboard.readText", null)).toBeNull();
      expect(invoke("clipboard.getFormats", null)).toEqual([]);
      for (const text of [
        "",
        "한글 😀\n\r\n",
        "😀".repeat(MAX_TEXT_LENGTH),
      ]) {
        expect(
          invoke("clipboard.writeText", {
            text,
          }),
        ).toBeNull();
        expect(invoke("clipboard.readText", null)).toBe(text);
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
      invoke("clipboard.writeFormats", {
        items,
      });
      expect(invoke("clipboard.getFormats", null)).toEqual(
        items.map((item) => item.format),
      );
      expect(
        invoke("clipboard.readFormats", {
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
      expect(() => invoke("clipboard.clear", null, [])).toThrow(
        expect.objectContaining({
          code: "PERMISSION_DENIED",
        }),
      );
      expect(observer.read("text/plain").data).toBe("fallback 한글 😀");
      expect(() =>
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
      ).toThrow(
        expect.objectContaining({
          code: "UNSUPPORTED",
        }),
      );
      expect(observer.read("text/plain").data).toBe("fallback 한글 😀");
      expect(
        invoke("clipboard.hasFormat", {
          format: "application/x-bunaway-file-list",
        }),
      ).toBe(false);
      expect(
        invoke("clipboard.readFormats", {
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
      const maximum = {
        width: 512,
        height: 256,
        rgba: Buffer.alloc(MAX_IMAGE_BYTES, 17).toString("base64"),
      };
      invoke("clipboard.writeImage", maximum);
      expect(invoke("clipboard.readImage", null)).toEqual(maximum);
      expect(invoke("clipboard.readText", null)).toBeNull();
      expect(
        invoke("clipboard.hasFormat", {
          format: "text/html",
        }),
      ).toBe(false);
      expect(
        invoke("clipboard.readFormats", {
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
      expect(() =>
        invoke("clipboard.writeText", {
          text: "x".repeat(MAX_TEXT_LENGTH + 1),
        }),
      ).toThrow(
        expect.objectContaining({
          code: "INVALID_ARGUMENT",
        }),
      );
      expect(invoke("clipboard.readImage", null)).toEqual(maximum);
      invoke("clipboard.clear", null);
      expect(invoke("clipboard.readImage", null)).toBeNull();
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
        expect(() => invoke(operation, null)).toThrow(
          expect.objectContaining({
            code: "INTERNAL",
          }),
        );
      }
      installExternal("tests.bunaway.unknown", Buffer.from("unknown data"));
      expect(invoke("clipboard.readText", null)).toBeNull();
      expect(invoke("clipboard.getFormats", null)).toEqual([]);
      adapter.dispose();
      adapter.dispose();
      expect(() => invoke("clipboard.clear", null)).toThrow(
        expect.objectContaining({
          code: "CANCELLED",
        }),
      );
    } finally {
      adapter.dispose();
      observer.dispose();
    }
  },
);
