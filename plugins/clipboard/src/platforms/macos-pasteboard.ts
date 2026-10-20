import { dlopen, type Pointer, ptr, toArrayBuffer } from "bun:ffi";
import {
  LIBSYSTEM,
  LIBSYSTEM_PATH,
  OBJC_PATH as OBJC,
  OBJC_RUNTIME,
} from "@bunaway/plugin/darwin";
import { pick } from "@bunaway/plugin/win32";
import { BunawayError } from "@bunaway/protocol";
import {
  type ClipboardFormat,
  MAX_PATH_LENGTH,
  MAX_TEXT_LENGTH,
  type MacosClipboardItem,
  posixFilesSchema,
  rtfSchema,
  textSchema,
} from "#clipboard/contract";
import {
  decodeTIFF,
  encodeTIFF,
  invalidPasteboardData,
  MAX_TIFF_BYTES,
} from "#clipboard/platforms/macos-tiff";

const APPKIT = "/System/Library/Frameworks/AppKit.framework/AppKit";
const NS_UTF8_ENCODING = 4;
const MAX_STRING_BYTES = MAX_TEXT_LENGTH * 4;
const FILE_URL_TYPE = "public.file-url";
// A path of MAX_PATH_LENGTH code units grows to at most 9 bytes each when percent-encoded.
const MAX_FILE_URL_BYTES = MAX_PATH_LENGTH * 9 + 16;
const FILE_LIST = "application/x-bunaway-file-list";
const nativeTypes = {
  "text/plain": "public.utf8-plain-text",
  "text/html": "public.html",
  "text/rtf": "public.rtf",
  "image/bmp": "public.tiff",
  [FILE_LIST]: FILE_URL_TYPE,
} as const;
type SupportedFormat = keyof typeof nativeTypes;

export type Pasteboard = {
  read(format: ClipboardFormat):
    | MacosClipboardItem
    | {
        format: ClipboardFormat;
        data: null;
      };
  readMany(formats: ClipboardFormat[]): ReturnType<Pasteboard["read"]>[];
  has(format: ClipboardFormat): boolean;
  write(items: MacosClipboardItem[]): void;
  clear(): void;
  dispose(): void;
};

/** Only explicitly mapped representations are supported on macOS. */
export function supportedFormat(
  format: ClipboardFormat,
): format is SupportedFormat {
  return (
    format === "text/plain" ||
    format === "text/html" ||
    format === "text/rtf" ||
    format === "image/bmp" ||
    format === FILE_LIST
  );
}

/** Percent-encode every path segment so the URL round-trips without normalization. */
export function fileUrl(path: string): string {
  return `file://${path.split("/").map(encodeURIComponent).join("/")}`;
}

/**
 * Local path of a `file:` URL, or null for URLs that do not name a local path: remote hosts and
 * file reference URLs (`/.file/id=`). Malformed URLs are invalid pasteboard data.
 */
export function filePath(url: string): string | null {
  const match = /^file:\/\/([^/?#]*)(\/[^?#]*)$/iu.exec(url);
  if (!match) {
    return /^file:/iu.test(url) ? invalidPasteboardData() : null;
  }
  const host = (match[1] ?? "").toLowerCase();
  if (host !== "" && host !== "localhost") {
    return null;
  }
  let path: string;
  try {
    path = decodeURIComponent(match[2] ?? "");
  } catch {
    return invalidPasteboardData();
  }
  if (path.startsWith("/.file/")) {
    return null;
  }
  // Finder ends directory URLs with a slash that is not part of the path.
  return path.length > 1 ? path.replace(/\/+$/u, "") || "/" : path;
}

function supportedItem(item: MacosClipboardItem): item is Extract<
  MacosClipboardItem,
  {
    format: SupportedFormat;
  }
> {
  return supportedFormat(item.format);
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
      dlopen(LIBSYSTEM_PATH, pick(LIBSYSTEM, "pthread_main_np")),
    );
    const runtime = own(
      dlopen(OBJC, {
        ...pick(OBJC_RUNTIME, "objc_getClass", "sel_registerName"),
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
      const result = BigInt(runtime.symbols.objc_getClass(cstring(value)) ?? 0);
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
        method = BigInt(
          runtime.symbols.sel_registerName(cstring(selector)) ?? 0,
        );
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
    const readFiles = (board: bigint): string[] | null => {
      const items = send(board, "pasteboardItems");
      if (!items) {
        return null;
      }
      const count = Number(send(items, "count"));
      const type = string(FILE_URL_TYPE);
      const paths: string[] = [];
      for (let index = 0; index < count; index += 1) {
        const native = send(
          send(items, "objectAtIndex:", index),
          "dataForType:",
          type,
        );
        if (!native) {
          continue;
        }
        let url: string;
        try {
          url = new TextDecoder("utf-8", {
            fatal: true,
            ignoreBOM: true,
          }).decode(readBytes(native, MAX_FILE_URL_BYTES));
        } catch {
          return invalidPasteboardData();
        }
        const path = filePath(url);
        if (path !== null) {
          paths.push(path);
        }
      }
      if (paths.length === 0) {
        return null;
      }
      const parsed = posixFilesSchema.safeParse(paths);
      return parsed.success ? parsed.data : invalidPasteboardData();
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
          // Only the first pasteboard item's types are listed; a reference-only file URL still reads as null.
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
          if (format === FILE_LIST) {
            return {
              format,
              data: readFiles(board),
            };
          }
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
        if (items.some((item) => !supportedItem(item))) {
          throw new BunawayError({
            code: "UNSUPPORTED",
            message: "This clipboard format is unsupported on macOS.",
          });
        }
        transaction((board) => {
          // Prepare and populate every item before clearing the desktop pasteboard.
          // The first item carries the single-valued formats and the first file;
          // each further file gets its own item, as Finder does.
          const created: bigint[] = [];
          const prepare = () => {
            const item = requireObject(
              send(classOf("NSPasteboardItem"), "new"),
            );
            created.push(item);
            return item;
          };
          const populate = (item: bigint, bytes: Buffer, type: string) => {
            if (
              !(
                send(item, "setData:forType:", data(bytes), string(type)) &
                0xffn
              )
            ) {
              invalidPasteboardData();
            }
          };
          try {
            const first = prepare();
            for (const entry of items) {
              if (entry.format === FILE_LIST) {
                entry.data.forEach((path, index) => {
                  populate(
                    index === 0 ? first : prepare(),
                    Buffer.from(fileUrl(path), "utf8"),
                    FILE_URL_TYPE,
                  );
                });
              } else if (entry.format === "image/bmp") {
                populate(
                  first,
                  encodeTIFF(entry.data),
                  nativeTypes[entry.format],
                );
              } else if (supportedItem(entry)) {
                populate(
                  first,
                  Buffer.from(entry.data, "utf8"),
                  nativeTypes[entry.format],
                );
              }
            }
            const array = requireObject(
              send(
                classOf("NSMutableArray"),
                "arrayWithCapacity:",
                created.length,
              ),
            );
            for (const item of created) {
              send(array, "addObject:", item);
            }
            send(board, "clearContents");
            // The OS owns copied representations. A failed commit is not rolled back.
            if (!(send(board, "writeObjects:", array) & 0xffn)) {
              invalidPasteboardData();
            }
          } finally {
            for (const item of created) {
              send(item, "release");
            }
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
