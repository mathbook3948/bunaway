import { dlopen, type Pointer, ptr } from "bun:ffi";
import { OLE32, pick, wide } from "@bunaway/plugin/win32";
import { BunawayError } from "@bunaway/protocol";
import type {
  ShortcutDetails,
  ShortcutLink,
  ShortcutOperation,
} from "#opener/contract";
import { ComScope, guid, SHELL_LINK_SLOT } from "#opener/platforms/windows-com";

const CLSCTX_INPROC_SERVER = 0x1;
const STGM_READ = 0;
const SLGP_RAWPATH = 0x4;
// A text buffer holds the longest accepted text plus its NUL.
const TEXT_UNITS = 32768;
const ICON_INDEX_BYTES = 4;
const COM_SLOT = {
  ...SHELL_LINK_SLOT,
  // IPersistFile
  load: 5,
  save: 6,
} as const;

const CLSID_SHELL_LINK = guid("00021401-0000-0000-c000-000000000046");
const IID_SHELL_LINK = guid("000214f9-0000-0000-c000-000000000046");
const IID_PERSIST_FILE = guid("0000010b-0000-0000-c000-000000000046");

function shortcutFailed(): BunawayError {
  return new BunawayError({
    code: "INTERNAL",
    message: "Windows could not process the shortcut.",
  });
}

function notShortcut(): BunawayError {
  return new BunawayError({
    code: "INVALID_ARGUMENT",
    message: "Opener file is not a readable Windows shortcut.",
    details: {
      reason: "NOT_A_SHORTCUT",
    },
  });
}

/** One shortcut object (`IShellLinkW` with its `IPersistFile`) owned for a single request. */
class ShortcutObject {
  readonly #com = new ComScope(shortcutFailed);
  readonly #link: Pointer;
  readonly #file: Pointer;

  constructor(create: (out: Pointer) => number) {
    try {
      this.#link = this.#com.acquire(create);
      this.#file = this.#com.queryInterface(this.#link, IID_PERSIST_FILE);
    } catch (error) {
      // The caller never receives the object, so release what was acquired here.
      this.release();
      throw error;
    }
  }

  #call(object: Pointer, slot: number, args: ("ptr" | "i32" | "u32")[]) {
    return this.#com.call(object, slot, args);
  }

  /** Load an existing shortcut file; any failure means the file is not a usable shortcut. */
  load(path: string): void {
    const name = wide(path);
    const result = this.#call(this.#file, COM_SLOT.load, [
      "ptr",
      "u32",
    ])(ptr(name), STGM_READ);
    if (result < 0) {
      throw notShortcut();
    }
  }

  save(path: string): void {
    const name = wide(path);
    const result = this.#call(this.#file, COM_SLOT.save, [
      "ptr",
      "i32",
    ])(ptr(name), 1);
    if (result < 0) {
      throw shortcutFailed();
    }
  }

  /** Apply the named properties; a failed setter fails the whole request. */
  apply(details: ShortcutDetails): void {
    const set = (slot: number, value: string | undefined) => {
      if (value === undefined) {
        return;
      }
      const text = wide(value);
      if (
        this.#call(this.#link, slot, [
          "ptr",
        ])(ptr(text)) < 0
      ) {
        throw shortcutFailed();
      }
    };
    set(COM_SLOT.setPath, details.target);
    set(COM_SLOT.setWorkingDirectory, details.cwd);
    set(COM_SLOT.setArguments, details.args);
    set(COM_SLOT.setDescription, details.description);
    if (details.icon !== undefined || details.iconIndex !== undefined) {
      const current = this.#readIcon();
      const text = wide(details.icon ?? current.icon);
      const index = details.iconIndex ?? current.iconIndex;
      if (
        this.#call(this.#link, COM_SLOT.setIconLocation, [
          "ptr",
          "i32",
        ])(ptr(text), index) < 0
      ) {
        throw shortcutFailed();
      }
    }
  }

  #text(slot: number): string {
    const output = Buffer.alloc(TEXT_UNITS * 2);
    const result = this.#call(this.#link, slot, [
      "ptr",
      "i32",
    ])(ptr(output), TEXT_UNITS);
    if (result < 0) {
      throw shortcutFailed();
    }
    return output.toString("utf16le").split("\0", 1)[0] ?? "";
  }

  #readIcon(): {
    icon: string;
    iconIndex: number;
  } {
    const output = Buffer.alloc(TEXT_UNITS * 2);
    const index = Buffer.alloc(ICON_INDEX_BYTES);
    const result = this.#call(this.#link, COM_SLOT.getIconLocation, [
      "ptr",
      "i32",
      "ptr",
    ])(ptr(output), TEXT_UNITS, ptr(index));
    if (result < 0) {
      throw shortcutFailed();
    }
    return {
      icon: output.toString("utf16le").split("\0", 1)[0] ?? "",
      iconIndex: index.readInt32LE(0),
    };
  }

  read(): ShortcutLink {
    const output = Buffer.alloc(TEXT_UNITS * 2);
    const result = this.#call(this.#link, COM_SLOT.getPath, [
      "ptr",
      "i32",
      "ptr",
      "u32",
    ])(ptr(output), TEXT_UNITS, null, SLGP_RAWPATH);
    if (result < 0) {
      throw shortcutFailed();
    }
    return {
      target: output.toString("utf16le").split("\0", 1)[0] ?? "",
      cwd: this.#text(COM_SLOT.getWorkingDirectory),
      args: this.#text(COM_SLOT.getArguments),
      description: this.#text(COM_SLOT.getDescription),
      ...this.#readIcon(),
    };
  }

  release(): void {
    this.#com.release();
  }
}

/**
 * Bind the COM entry points for Shell shortcut files. Objects are created and released
 * on the opener's initialized STA, one per request. Dispose after the adapter stops.
 */
export function createShortcuts() {
  const ole = dlopen("ole32.dll", {
    ...pick(OLE32, "CoCreateInstance"),
  });
  let disposed = false;

  function withShortcut<T>(use: (shortcut: ShortcutObject) => T): T {
    if (disposed) {
      throw new BunawayError({
        code: "CANCELLED",
        message: "Opener has been disposed.",
      });
    }
    const shortcut = new ShortcutObject((out) =>
      ole.symbols.CoCreateInstance(
        ptr(CLSID_SHELL_LINK),
        null,
        CLSCTX_INPROC_SERVER,
        ptr(IID_SHELL_LINK),
        out,
      ),
    );
    try {
      return use(shortcut);
    } finally {
      shortcut.release();
    }
  }

  return {
    /** Read the properties of an existing shortcut file without resolving its target. */
    read(path: string): ShortcutLink {
      return withShortcut((shortcut) => {
        shortcut.load(path);
        return shortcut.read();
      });
    },
    /**
     * Write a shortcut file. `update` loads the file and changes the named properties;
     * `create` and `replace` write a new link holding only the named properties.
     */
    write(
      path: string,
      details: ShortcutDetails,
      operation: ShortcutOperation,
    ): void {
      withShortcut((shortcut) => {
        if (operation === "update") {
          shortcut.load(path);
        }
        shortcut.apply(details);
        shortcut.save(path);
      });
    },
    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      ole.close();
    },
  };
}
