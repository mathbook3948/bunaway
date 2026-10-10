import { dlopen, ptr, toArrayBuffer } from "bun:ffi";
import { BunawayError, validateValue } from "@bunaway/protocol";
import { MAX_TEXT_LENGTH, textSchema } from "./text.ts";

const CF_UNICODETEXT = 13;
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
  return {
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
          return validateValue(textSchema, text);
        } catch {
          throw failed();
        }
      } finally {
        unlock(handle);
      }
    },
    write(text: string) {
      const bytes = Buffer.from(`${text}\0`, "utf16le");
      const handle = memory.GlobalAlloc(GMEM_MOVEABLE, bytes.byteLength);
      if (!handle) {
        throw failed();
      }
      let transferred = false;
      try {
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
        // Allocate and fill before clearing so allocation failures preserve old data.
        if (!api.EmptyClipboard()) {
          throw failed();
        }
        if (!api.SetClipboardData(CF_UNICODETEXT, handle)) {
          throw failed();
        }
        transferred = true;
      } finally {
        if (!transferred) {
          free(handle);
        }
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
}
