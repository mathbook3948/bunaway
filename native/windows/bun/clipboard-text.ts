import { dlopen, read, toArrayBuffer } from "bun:ffi";

const CF_UNICODETEXT = 13;
// Longest clipboard text inserted by the host; larger content is refused rather than truncated.
const MAX_CLIPBOARD_CHARS = 1_048_576;

/** Outcome of one attempt to read plain text from the system clipboard. */
export type ClipboardTextResult =
  | {
      kind: "text";
      text: string;
    }
  /** No CF_UNICODETEXT data, or only an empty string. */
  | {
      kind: "empty";
    }
  /** Another process holds the clipboard, or the data could not be locked. */
  | {
      kind: "unavailable";
    }
  | {
      kind: "too-large";
    };

/**
 * Read CF_UNICODETEXT once, without waiting for a contended clipboard.
 *
 * The clipboard is opened for the current task (no owner window) and closed before returning,
 * so a failed read never leaves it held. Call on the UI STA; the data is copied out while the
 * clipboard is open, and the length comes from the allocation size so a missing terminator
 * cannot read past the block.
 */
export function readClipboardText(): ClipboardTextResult {
  const native = dlopen("user32.dll", {
    OpenClipboard: {
      args: [
        "u64",
      ],
      returns: "i32",
    },
    CloseClipboard: {
      args: [],
      returns: "i32",
    },
    IsClipboardFormatAvailable: {
      args: [
        "u32",
      ],
      returns: "i32",
    },
    GetClipboardData: {
      args: [
        "u32",
      ],
      returns: "ptr",
    },
  });
  const memory = dlopen("kernel32.dll", {
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
      returns: "i32",
    },
    GlobalSize: {
      args: [
        "ptr",
      ],
      returns: "u64",
    },
  });
  try {
    if (!native.symbols.OpenClipboard(0n)) {
      return {
        kind: "unavailable",
      };
    }
    try {
      if (!native.symbols.IsClipboardFormatAvailable(CF_UNICODETEXT)) {
        return {
          kind: "empty",
        };
      }
      const handle = native.symbols.GetClipboardData(CF_UNICODETEXT);
      if (!handle) {
        return {
          kind: "unavailable",
        };
      }
      const address = memory.symbols.GlobalLock(handle);
      if (!address) {
        return {
          kind: "unavailable",
        };
      }
      try {
        const capacity = Math.floor(
          Number(memory.symbols.GlobalSize(handle)) / 2,
        );
        let chars = 0;
        while (chars < capacity && read.u16(address, chars * 2)) {
          chars++;
          if (chars > MAX_CLIPBOARD_CHARS) {
            return {
              kind: "too-large",
            };
          }
        }
        if (chars === 0) {
          return {
            kind: "empty",
          };
        }
        return {
          kind: "text",
          text: Buffer.from(toArrayBuffer(address, 0, chars * 2)).toString(
            "utf16le",
          ),
        };
      } finally {
        memory.symbols.GlobalUnlock(handle);
      }
    } finally {
      native.symbols.CloseClipboard();
    }
  } finally {
    native.close();
    memory.close();
  }
}
