import { dlopen, ptr, toArrayBuffer } from "bun:ffi";
import { BunawayError, validateValue } from "@bunaway/protocol";
import {
  builtInFormatSchema,
  type ClipboardFormat,
  type ClipboardItem,
  fitsFormatBudget,
  MAX_BINARY_FORMATS,
  MAX_TEXT_LENGTH,
  textSchema,
} from "#clipboard/contract";
import {
  decodeBinary,
  decodeBookmark,
  decodeFiles,
  decodeHTML,
  decodeImage,
  decodeRTF,
  encodeItem,
  invalidClipboardData,
  MAX_NATIVE_FORMAT_BYTES,
} from "#clipboard/platforms/windows-codecs";

const CF_UNICODETEXT = 13;
const CF_DIB = 8;
const CF_HDROP = 15;
const CF_DIBV5 = 17;
const GMEM_MOVEABLE = 0x0002;
const UTF16_BYTES = 2;
// Each Unicode scalar can occupy two UTF-16 code units, plus the terminator.
const MAX_TEXT_BYTES = (MAX_TEXT_LENGTH * 2 + 1) * UTF16_BYTES;

function failed(): BunawayError {
  return new BunawayError({
    code: "INTERNAL",
    message: "Windows clipboard operation failed.",
  });
}

/**
 * Own a hidden clipboard owner window and DLL bindings on the UI thread.
 * Call close after every successful open. Borrowed read handles never escape that
 * interval. Successful writes transfer their HGLOBAL to Windows.
 */
export function createClipboard() {
  const user = dlopen("user32.dll", {
    CreateWindowExW: {
      args: [
        "u32",
        "ptr",
        "ptr",
        "u32",
        "i32",
        "i32",
        "i32",
        "i32",
        "ptr",
        "ptr",
        "ptr",
        "ptr",
      ],
      returns: "ptr",
    },
    DestroyWindow: {
      args: [
        "ptr",
      ],
      returns: "bool",
    },
    OpenClipboard: {
      args: [
        "ptr",
      ],
      returns: "bool",
    },
    CloseClipboard: {
      args: [],
      returns: "bool",
    },
    EmptyClipboard: {
      args: [],
      returns: "bool",
    },
    IsClipboardFormatAvailable: {
      args: [
        "u32",
      ],
      returns: "bool",
    },
    GetClipboardData: {
      args: [
        "u32",
      ],
      returns: "ptr",
    },
    SetClipboardData: {
      args: [
        "u32",
        "ptr",
      ],
      returns: "ptr",
    },
    RegisterClipboardFormatW: {
      args: [
        "ptr",
      ],
      returns: "u32",
    },
  });
  const kernel = (() => {
    try {
      return dlopen("kernel32.dll", {
        GetModuleHandleW: {
          args: [
            "ptr",
          ],
          returns: "ptr",
        },
        GlobalAlloc: {
          args: [
            "u32",
            "u64",
          ],
          returns: "ptr",
        },
        GlobalFree: {
          args: [
            "ptr",
          ],
          returns: "ptr",
        },
        GlobalLock: {
          args: [
            "ptr",
          ],
          returns: "ptr",
        },
        GlobalUnlock: {
          args: [
            "ptr",
          ],
          returns: "bool",
        },
        GlobalSize: {
          args: [
            "ptr",
          ],
          returns: "u64",
        },
        SetLastError: {
          args: [
            "u32",
          ],
          returns: "void",
        },
        GetLastError: {
          args: [],
          returns: "u32",
        },
      });
    } catch (error) {
      user.close();
      throw error;
    }
  })();
  const api = user.symbols;
  const memory = kernel.symbols;
  const className = Buffer.from("STATIC\0", "utf16le");
  // A non-null owner is required by EmptyClipboard followed by SetClipboardData.
  const owner = api.CreateWindowExW(
    0,
    ptr(className),
    null,
    0,
    0,
    0,
    0,
    0,
    null,
    null,
    memory.GetModuleHandleW(null),
    null,
  );
  if (!owner) {
    kernel.close();
    user.close();
    throw failed();
  }
  let disposed = false;
  let opened = false;
  function unlock(handle: NonNullable<ReturnType<typeof memory.GlobalLock>>) {
    memory.SetLastError(0);
    // A final successful unlock returns false with ERROR_SUCCESS.
    if (!memory.GlobalUnlock(handle) && memory.GetLastError() !== 0) {
      throw failed();
    }
  }
  function free(handle: NonNullable<ReturnType<typeof memory.GlobalAlloc>>) {
    if (memory.GlobalFree(handle)) {
      throw failed();
    }
  }
  const registered = new Map<string, number>();
  let binaryFormats = 0;
  function nativeFormat(format: ClipboardFormat): number {
    switch (format) {
      case "text/plain":
        return CF_UNICODETEXT;
      case "application/x-bunaway-file-list":
        return CF_HDROP;
      case "image/bmp":
        return CF_DIBV5;
      default: {
        let name: string;
        switch (format) {
          case "text/html":
            name = "HTML Format";
            break;
          case "text/rtf":
            name = "Rich Text Format";
            break;
          case "application/x-bunaway-bookmark":
            name = "UniformResourceLocatorW";
            break;
          default:
            name = format;
        }
        const existing = registered.get(name);
        if (existing !== undefined) {
          return existing;
        }
        const binary = format.startsWith("application/x-bunaway-binary/");
        if (binary && binaryFormats >= MAX_BINARY_FORMATS) {
          throw new BunawayError({
            code: "BUSY",
            message: "Clipboard binary format registration limit reached.",
          });
        }
        const wideName = Buffer.from(`${name}\0`, "utf16le");
        const value = api.RegisterClipboardFormatW(ptr(wideName));
        if (!value) {
          throw failed();
        }
        registered.set(name, value);
        if (binary) {
          binaryFormats++;
        }
        return value;
      }
    }
  }
  function copyData(format: number, maxBytes: number): Buffer {
    const handle = api.GetClipboardData(format);
    if (!handle) {
      throw failed();
    }
    const size = Number(memory.GlobalSize(handle));
    if (!Number.isSafeInteger(size) || size < 1 || size > maxBytes) {
      invalidClipboardData();
    }
    const address = memory.GlobalLock(handle);
    if (!address) {
      throw failed();
    }
    try {
      // Copy before unlocking; no borrowed Windows pointer survives the open interval.
      return Buffer.from(new Uint8Array(toArrayBuffer(address, 0, size)));
    } finally {
      unlock(handle);
    }
  }
  const clipboard = {
    open() {
      if (disposed) {
        throw new BunawayError({
          code: "CANCELLED",
          message: "Clipboard adapter is closed.",
        });
      }
      // A failed close still owns the open interval; only cleanup may retry it.
      if (opened) {
        throw failed();
      }
      opened = api.OpenClipboard(owner);
      return opened;
    },
    close() {
      if (opened) {
        if (!api.CloseClipboard()) {
          throw failed();
        }
        opened = false;
      }
    },
    read(): string | null {
      if (!api.IsClipboardFormatAvailable(CF_UNICODETEXT)) {
        return null;
      }
      const handle = api.GetClipboardData(CF_UNICODETEXT);
      if (!handle) {
        throw failed();
      }
      const size = Number(memory.GlobalSize(handle));
      if (
        size < UTF16_BYTES ||
        size > MAX_TEXT_BYTES ||
        size % UTF16_BYTES !== 0
      ) {
        throw failed();
      }
      const address = memory.GlobalLock(handle);
      if (!address) {
        throw failed();
      }
      try {
        const bytes = Buffer.from(toArrayBuffer(address, 0, size));
        let end = 0;
        while (end < size && bytes.readUInt16LE(end) !== 0) {
          end += UTF16_BYTES;
        }
        if (end === size) {
          throw failed();
        }
        const text = bytes.subarray(0, end).toString("utf16le");
        try {
          return textSchema.parse(validateValue({}, text));
        } catch {
          throw failed();
        }
      } finally {
        unlock(handle);
      }
    },
    write(text: string) {
      clipboard.writeFormats([
        {
          format: "text/plain",
          data: text,
        },
      ]);
    },
    /** One open interval snapshots all requested supported formats; missing formats return null. */
    readFormats(formats: ClipboardFormat[]) {
      const items = formats.map(
        (
          format,
        ):
          | ClipboardItem
          | {
              format: ClipboardFormat;
              data: null;
            } => {
          if (!clipboard.hasFormat(format)) {
            return {
              format,
              data: null,
            };
          }
          if (format === "text/plain") {
            return {
              format,
              data: clipboard.read(),
            };
          }
          if (format === "image/bmp") {
            return {
              format,
              data: clipboard.readImage(),
            };
          }
          const bytes = copyData(nativeFormat(format), MAX_NATIVE_FORMAT_BYTES);
          switch (format) {
            case "text/html":
              return {
                format,
                data: decodeHTML(bytes),
              };
            case "text/rtf":
              return {
                format,
                data: decodeRTF(bytes),
              };
            case "application/x-bunaway-file-list":
              return {
                format,
                data: decodeFiles(bytes),
              };
            case "application/x-bunaway-bookmark":
              return {
                format,
                data: decodeBookmark(bytes),
              };
            default:
              return {
                format,
                data: decodeBinary(bytes),
              };
          }
        },
      );
      if (!fitsFormatBudget(items)) {
        invalidClipboardData();
      }
      return items;
    },
    hasFormat(format: ClipboardFormat): boolean {
      return (
        api.IsClipboardFormatAvailable(nativeFormat(format)) ||
        (format === "image/bmp" && api.IsClipboardFormatAvailable(CF_DIB))
      );
    },
    getFormats() {
      return builtInFormatSchema.options.filter((format) =>
        clipboard.hasFormat(format),
      );
    },
    readImage() {
      let format = CF_DIBV5;
      if (!api.IsClipboardFormatAvailable(format)) {
        format = CF_DIB;
        if (!api.IsClipboardFormatAvailable(format)) {
          return null;
        }
      }
      return decodeImage(copyData(format, MAX_NATIVE_FORMAT_BYTES));
    },
    /** Prepare every HGLOBAL before clearing; transfer each successfully installed handle once. */
    writeFormats(items: ClipboardItem[]) {
      const allocations: {
        format: number;
        handle: NonNullable<ReturnType<typeof memory.GlobalAlloc>>;
        transferred: boolean;
      }[] = [];
      const failures: unknown[] = [];
      try {
        for (const item of items) {
          const bytes = encodeItem(item);
          const format = nativeFormat(item.format);
          const handle = memory.GlobalAlloc(GMEM_MOVEABLE, bytes.byteLength);
          if (!handle) {
            throw failed();
          }
          allocations.push({
            format,
            handle,
            transferred: false,
          });
          const address = memory.GlobalLock(handle);
          if (!address) {
            throw failed();
          }
          try {
            new Uint8Array(toArrayBuffer(address, 0, bytes.byteLength)).set(
              bytes,
            );
          } finally {
            unlock(handle);
          }
        }
        if (!api.EmptyClipboard()) {
          throw failed();
        }
        for (const allocation of allocations) {
          if (!api.SetClipboardData(allocation.format, allocation.handle)) {
            throw failed();
          }
          allocation.transferred = true;
        }
      } catch (error) {
        failures.push(error);
      }
      // A later registration failure leaves earlier formats installed. Windows
      // owns them; cleanup must still attempt every untransferred allocation.
      for (const allocation of allocations) {
        if (allocation.transferred) {
          continue;
        }
        try {
          free(allocation.handle);
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length === 1) {
        throw failures[0];
      }
      if (failures.length > 1) {
        throw new AggregateError(
          failures,
          "Clipboard write and cleanup failed.",
        );
      }
    },
    clear() {
      if (!api.EmptyClipboard()) {
        throw failed();
      }
    },
    dispose() {
      if (disposed) {
        return;
      }
      if (opened) {
        if (!api.CloseClipboard()) {
          throw failed();
        }
        opened = false;
      }
      if (!api.DestroyWindow(owner)) {
        throw failed();
      }
      disposed = true;
      kernel.close();
      user.close();
    },
  };
  return clipboard;
}
