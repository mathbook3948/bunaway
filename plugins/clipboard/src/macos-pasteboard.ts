import { dlopen, type Pointer, ptr, toArrayBuffer } from "bun:ffi";
import { BunawayError } from "@bunaway/protocol";
import type { ClipboardFormat, ClipboardItem } from "./formats.ts";
import { rtfSchema } from "./formats.ts";
import {
  decodeTIFF,
  encodeTIFF,
  invalidPasteboardData,
  MAX_TIFF_BYTES,
} from "./macos-tiff.ts";
import { MAX_TEXT_LENGTH, textSchema } from "./text.ts";

const OBJC = "/usr/lib/libobjc.A.dylib";
const APPKIT = "/System/Library/Frameworks/AppKit.framework/AppKit";
const NS_UTF8_ENCODING = 4;
const MAX_STRING_BYTES = MAX_TEXT_LENGTH * 4;
const nativeTypes = {
  "text/plain": "public.utf8-plain-text",
  "text/html": "public.html",
  "text/rtf": "public.rtf",
  "image/bmp": "public.tiff",
} as const;
type SupportedFormat = keyof typeof nativeTypes;

export type Pasteboard = {
  read(format: ClipboardFormat):
    | ClipboardItem
    | {
        format: ClipboardFormat;
        data: null;
      };
  readMany(formats: ClipboardFormat[]): ReturnType<Pasteboard["read"]>[];
  has(format: ClipboardFormat): boolean;
  write(items: ClipboardItem[]): void;
  clear(): void;
  dispose(): void;
};

/** Shared file-list inputs describe Windows paths and have no macOS representation. */
export function supportedFormat(
  format: ClipboardFormat,
): format is SupportedFormat {
  return format !== "application/x-bunaway-file-list";
}

/**
 * Own direct system bindings. Objects returned by Objective-C remain unsigned
 * 64-bit integers, including tagged NSStrings; only NSData bytes become pointers.
 * Every transaction drains its autorelease pool before returning copied JSON.
 * A trusted fixture may select a uniquely named pasteboard instead of the desktop.
 */
export function createPasteboard(name?: string): Pasteboard {
  const resources: {
    close(): void;
  }[] = [];
  const own = <
    T extends {
      close(): void;
    },
  >(
    resource: T,
  ): T => {
    resources.push(resource);
    return resource;
  };
  const close = () => {
    for (const resource of resources.splice(0).reverse()) {
      resource.close();
    }
  };
  try {
    // Bun requires a nonempty symbol table even when a framework is only loaded.
    own(
      dlopen(APPKIT, {
        NSApplicationLoad: {
          args: [],
          returns: "bool",
        },
      } as const),
    );
    const system = own(
      dlopen("/usr/lib/libSystem.B.dylib", {
        pthread_main_np: {
          args: [],
          returns: "i32",
        },
      } as const),
    );
    const runtime = own(
      dlopen(OBJC, {
        objc_getClass: {
          args: [
            "cstring",
          ],
          returns: "u64",
        },
        sel_registerName: {
          args: [
            "cstring",
          ],
          returns: "u64",
        },
        objc_msgSend: {
          args: [
            "u64",
            "u64",
            "u64",
            "u64",
            "u64",
            "u64",
          ],
          returns: "u64",
        },
      } as const),
    );
    const selectors = new Map<string, bigint>();
    let disposed = false;
    if (!system.symbols.pthread_main_np()) {
      close();
      throw new BunawayError({
        code: "UNSUPPORTED",
        message: "Clipboard requires the macOS main thread.",
      });
    }
    const cstring = (value: string) => ptr(Buffer.from(`${value}\0`));
    const classOf = (value: string) => {
      const result = BigInt(runtime.symbols.objc_getClass(cstring(value)));
      if (!result) {
        invalidPasteboardData();
      }
      return result;
    };
    const send = (
      object: bigint,
      selector: string,
      ...args: (bigint | number)[]
    ) => {
      let method = selectors.get(selector);
      if (!method) {
        method = BigInt(runtime.symbols.sel_registerName(cstring(selector)));
        selectors.set(selector, method);
      }
      return BigInt(
        runtime.symbols.objc_msgSend(
          object,
          method,
          BigInt(args[0] ?? 0),
          BigInt(args[1] ?? 0),
          BigInt(args[2] ?? 0),
          BigInt(args[3] ?? 0),
        ),
      );
    };
    const requireObject = (object: bigint) => {
      if (!object) {
        invalidPasteboardData();
      }
      return object;
    };
    const data = (bytes: Buffer) =>
      requireObject(
        send(
          classOf("NSData"),
          "dataWithBytes:length:",
          BigInt(ptr(bytes.length ? bytes : Buffer.alloc(1))),
          bytes.length,
        ),
      );
    const string = (value: string) => {
      const allocated = send(classOf("NSString"), "alloc");
      const result = requireObject(
        send(
          allocated,
          "initWithData:encoding:",
          data(Buffer.from(value, "utf8")),
          NS_UTF8_ENCODING,
        ),
      );
      return send(result, "autorelease");
    };
    const transaction = <T>(run: (board: bigint) => T): T => {
      if (disposed) {
        throw new BunawayError({
          code: "CANCELLED",
          message: "Clipboard adapter is disposed.",
        });
      }
      const pool = requireObject(
        send(send(classOf("NSAutoreleasePool"), "alloc"), "init"),
      );
      try {
        const board = requireObject(
          name === undefined
            ? send(classOf("NSPasteboard"), "generalPasteboard")
            : send(
                classOf("NSPasteboard"),
                "pasteboardWithName:",
                string(name),
              ),
        );
        return run(board);
      } finally {
        send(pool, "drain");
      }
    };
    const readBytes = (object: bigint, max: number): Buffer => {
      const length = Number(send(object, "length"));
      if (!Number.isSafeInteger(length) || length < 0 || length > max) {
        invalidPasteboardData();
      }
      if (length === 0) {
        return Buffer.alloc(0);
      }
      const address = send(object, "bytes");
      if (!address || address > BigInt(Number.MAX_SAFE_INTEGER)) {
        invalidPasteboardData();
      }
      // NSData owns the borrowed storage until this transaction's pool is drained.
      return Buffer.from(
        new Uint8Array(toArrayBuffer(Number(address) as Pointer, 0, length)),
      );
    };
    const pasteboard: Pasteboard = {
      readMany(requested) {
        // NSPasteboard has no reader lock. Reject a snapshot changed by another process.
        return transaction((board) => {
          const generation = send(board, "changeCount");
          const result = requested.map((format) => pasteboard.read(format));
          if (send(board, "changeCount") !== generation) {
            throw new BunawayError({
              code: "BUSY",
              message: "macOS clipboard changed while reading.",
            });
          }
          return result;
        });
      },
      has(format) {
        if (!supportedFormat(format)) {
          return false;
        }
        return transaction((board) => {
          const types = send(board, "types");
          return (
            (send(types, "containsObject:", string(nativeTypes[format])) &
              0xffn) !==
            0n
          );
        });
      },
      read(format) {
        if (!supportedFormat(format)) {
          return {
            format,
            data: null,
          };
        }
        return transaction((board): ReturnType<Pasteboard["read"]> => {
          const native = send(
            board,
            "dataForType:",
            string(nativeTypes[format]),
          );
          if (!native) {
            return {
              format,
              data: null,
            };
          }
          if (format === "image/bmp") {
            return {
              format,
              data: decodeTIFF(readBytes(native, MAX_TIFF_BYTES)),
            };
          }
          const bytes = readBytes(
            native,
            format === "text/rtf" ? MAX_TEXT_LENGTH : MAX_STRING_BYTES,
          );
          try {
            const decoded = new TextDecoder("utf-8", {
              fatal: true,
              ignoreBOM: true,
            }).decode(bytes);
            return {
              format,
              data: (format === "text/rtf" ? rtfSchema : textSchema).parse(
                decoded,
              ),
            };
          } catch {
            return invalidPasteboardData();
          }
        });
      },
      write(items) {
        if (items.some((item) => !supportedFormat(item.format))) {
          throw new BunawayError({
            code: "UNSUPPORTED",
            message: "macOS clipboard file lists are unsupported.",
          });
        }
        transaction((board) => {
          // Prepare and populate one item before clearing the desktop pasteboard.
          const item = requireObject(send(classOf("NSPasteboardItem"), "new"));
          try {
            for (const entry of items) {
              if (entry.format === "application/x-bunaway-file-list") {
                throw new BunawayError({
                  code: "UNSUPPORTED",
                  message: "macOS clipboard file lists are unsupported.",
                });
              }
              const bytes =
                entry.format === "image/bmp"
                  ? encodeTIFF(entry.data)
                  : Buffer.from(entry.data, "utf8");
              if (
                !(
                  send(
                    item,
                    "setData:forType:",
                    data(bytes),
                    string(nativeTypes[entry.format]),
                  ) & 0xffn
                )
              ) {
                invalidPasteboardData();
              }
            }
            const array = requireObject(
              send(classOf("NSArray"), "arrayWithObject:", item),
            );
            send(board, "clearContents");
            // The OS owns copied representations. A failed commit is not rolled back.
            if (!(send(board, "writeObjects:", array) & 0xffn)) {
              invalidPasteboardData();
            }
          } finally {
            send(item, "release");
          }
        });
      },
      clear() {
        transaction((board) => {
          send(board, "clearContents");
        });
      },
      dispose() {
        if (!disposed) {
          // Named CI boards are owned by their fixture and can be removed safely.
          if (name !== undefined) {
            transaction((board) => {
              send(board, "releaseGlobally");
            });
          }
          disposed = true;
          close();
        }
      },
    };
    return pasteboard;
  } catch (error) {
    close();
    throw error;
  }
}
