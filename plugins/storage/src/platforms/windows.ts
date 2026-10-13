import { dlopen, ptr } from "bun:ffi";
import { win32 } from "node:path";
import {
  BunawayError,
  type JsonValue,
  type NativeAdapter,
} from "@bunaway/plugin";
import type {
  StorageBytesWrite,
  StorageLocation,
  StorageMetadata,
  StorageWrite,
} from "../contract.ts";
import { MAX_STORAGE_BYTES } from "../bytes.ts";

const MAX_STORAGE_PATH_SEGMENT_BYTES = 255;
const MAX_STORAGE_FILE_BYTES = 4 * 1024 * 1024;
const MAX_IO_CHUNK_BYTES = 1 << 20;
const BY_HANDLE_FILE_INFORMATION_BYTES = 52;
const FILE_CREATION_TIME_OFFSET = 4;
const FILE_ACCESS_TIME_OFFSET = 12;
const FILE_WRITE_TIME_OFFSET = 20;
const FILE_SIZE_HIGH_OFFSET = 32;
const FILE_SIZE_LOW_OFFSET = 36;
const FINAL_PATH_BUFFER_CHARS = 32768;
const WCHAR_BYTES = 2;
const FILETIME_TICKS_PER_MS = 10_000n;
const WINDOWS_EPOCH_OFFSET_MS = 11_644_473_600_000n;

const ERROR_FILE_NOT_FOUND = 2;
const ERROR_PATH_NOT_FOUND = 3;
const ERROR_ACCESS_DENIED = 5;
const ERROR_ALREADY_EXISTS = 183;
const FILE_ATTRIBUTE_DIRECTORY = 0x10;
const FILE_ATTRIBUTE_REPARSE_POINT = 0x400;
const MAX_FILE_LINK_COUNT = 1;
const GENERIC_READ = 0x80000000;
const GENERIC_WRITE = 0x40000000;
const FILE_APPEND_DATA = 0x4;
const FILE_READ_ATTRIBUTES = 0x80;
const FILE_READ_DATA = 0x1;
const FILE_LIST_DIRECTORY = 0x1;
const FILE_SHARE_READ = 0x1;
const FILE_SHARE_WRITE = 0x2;
const FILE_SHARE_DELETE = 0x4;
const FILE_SHARE_ALL = FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE;
const OPEN_EXISTING = 3;
const OPEN_ALWAYS = 4;
const FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
const FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
const DIRECTORY_OPEN_FLAGS =
  FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS;

/** Create the I/O adapter and tie native binding cleanup to its host lifecycle. */
export function createOperations(): NativeAdapter {
  const storage = new WindowsStorage();
  return {
    execute(operation: string, input: JsonValue): JsonValue {
      // The host registry has validated this operation's input before dispatch.
      return storage.execute(
        operation,
        input as StorageLocation | StorageWrite | StorageBytesWrite,
      );
    },
    dispose: () => storage.dispose(),
  };
}

function wide(text: string): Buffer {
  return Buffer.from(`${text}\0`, "utf16le");
}
function createBindings() {
  return dlopen("kernel32.dll", {
    CreateFileW: {
      args: [
        "ptr",
        "u32",
        "u32",
        "ptr",
        "u32",
        "u32",
        "u64",
      ],
      returns: "u64",
    },
    CreateDirectoryW: {
      args: [
        "ptr",
        "ptr",
      ],
      returns: "i32",
    },
    GetLastError: {
      args: [],
      returns: "u32",
    },
    GetFileInformationByHandle: {
      args: [
        "u64",
        "ptr",
      ],
      returns: "i32",
    },
    GetFinalPathNameByHandleW: {
      args: [
        "u64",
        "ptr",
        "u32",
        "u32",
      ],
      returns: "u32",
    },
    GetFileSizeEx: {
      args: [
        "u64",
        "ptr",
      ],
      returns: "i32",
    },
    ReadFile: {
      args: [
        "u64",
        "ptr",
        "u32",
        "ptr",
        "ptr",
      ],
      returns: "i32",
    },
    WriteFile: {
      args: [
        "u64",
        "ptr",
        "u32",
        "ptr",
        "ptr",
      ],
      returns: "i32",
    },
    SetEndOfFile: {
      args: [
        "u64",
      ],
      returns: "i32",
    },
    CloseHandle: {
      args: [
        "u64",
      ],
      returns: "i32",
    },
  });
}
function deny(message: string): never {
  throw new BunawayError({
    code: "PERMISSION_DENIED",
    message,
  });
}
/** Convert a Win32 FILETIME to epoch milliseconds; zero means unavailable. */
function fileTimeMs(info: Buffer, offset: number): number | null {
  const ticks = info.readBigUInt64LE(offset);
  return ticks === 0n
    ? null
    : Number(ticks / FILETIME_TICKS_PER_MS - WINDOWS_EPOCH_OFFSET_MS);
}
/** Convert handle information to the public metadata shape. */
function metadata(info: Buffer): StorageMetadata {
  const times = {
    createdAtMs: fileTimeMs(info, FILE_CREATION_TIME_OFFSET),
    accessedAtMs: fileTimeMs(info, FILE_ACCESS_TIME_OFFSET),
    modifiedAtMs: fileTimeMs(info, FILE_WRITE_TIME_OFFSET),
  };
  if (info.readUInt32LE(0) & FILE_ATTRIBUTE_DIRECTORY) {
    return {
      kind: "directory",
      sizeBytes: null,
      ...times,
    };
  }
  const sizeBytes =
    (BigInt(info.readUInt32LE(FILE_SIZE_HIGH_OFFSET)) << 32n) |
    BigInt(info.readUInt32LE(FILE_SIZE_LOW_OFFSET));
  if (sizeBytes > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Storage size cannot be represented safely.");
  }
  return {
    kind: "file",
    sizeBytes: Number(sizeBytes),
    ...times,
  };
}
export class WindowsStorage {
  private readonly api = createBindings();
  private disposed = false;
  /** Release this instance's bindings; other storage adapters retain their resources. */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.api.close();
  }
  private check(value: number | bigint, message: string): void {
    if (!value) {
      this.fail(message);
    }
  }
  private fail(message: string, code = this.api.symbols.GetLastError()): never {
    if (code === ERROR_ACCESS_DENIED) {
      deny("Storage access denied.");
    }
    throw new Error(`${message} (${code})`);
  }
  private requireOpen(): void {
    if (this.disposed) {
      throw new BunawayError({
        code: "CANCELLED",
        message: "Storage adapter is disposed.",
      });
    }
  }
  private close(handle: bigint) {
    this.check(this.api.symbols.CloseHandle(handle), "CloseHandle failed");
  }
  private open(
    path: string,
    access: number,
    share: number,
    disposition: number,
    flags: number,
    allowMissing = false,
  ): bigint {
    const handle = this.api.symbols.CreateFileW(
      ptr(wide(path)),
      access,
      share,
      null,
      disposition,
      flags,
      0n,
    );
    if (handle === 0n || handle === 0xffffffffffffffffn) {
      const code = this.api.symbols.GetLastError();
      if (code === ERROR_FILE_NOT_FOUND || code === ERROR_PATH_NOT_FOUND) {
        if (allowMissing) {
          return 0n;
        }
        throw new BunawayError({
          code: "INVALID_ARGUMENT",
          message: "Storage target not found.",
        });
      }
      this.fail("Storage open failed", code);
    }
    return handle;
  }
  private info(handle: bigint) {
    const info = Buffer.alloc(BY_HANDLE_FILE_INFORMATION_BYTES);
    this.check(
      this.api.symbols.GetFileInformationByHandle(handle, ptr(info)),
      "Storage stat failed",
    );
    return info;
  }
  private canonical(handle: bigint) {
    const text = Buffer.alloc(FINAL_PATH_BUFFER_CHARS * WCHAR_BYTES);
    const length = this.api.symbols.GetFinalPathNameByHandleW(
      handle,
      ptr(text),
      FINAL_PATH_BUFFER_CHARS,
      0,
    );
    if (!length) {
      this.fail("Storage path check failed");
    }
    if (length >= FINAL_PATH_BUFFER_CHARS) {
      throw new Error("Storage path check failed");
    }
    return text.subarray(0, length * WCHAR_BYTES).toString("utf16le");
  }
  /**
   * Check an application-selected absolute path against pinned handles before I/O.
   * Missing metadata targets return `false` for exists and `null` for stat.
   */
  execute(
    operation: string,
    input: StorageLocation | StorageWrite | StorageBytesWrite,
  ): JsonValue {
    this.requireOpen();
    const path = input.path.replaceAll("/", "\\");
    const queryingMetadata =
      operation === "storage.exists" || operation === "storage.stat";
    const writingText =
      operation === "storage.writeText" || operation === "storage.appendText";
    const writingBytes =
      operation === "storage.writeBytes" || operation === "storage.appendBytes";
    const appending =
      operation === "storage.appendText" || operation === "storage.appendBytes";
    const writing = writingText || writingBytes;
    const readingBytes = operation === "storage.readBytes";
    if (
      !queryingMetadata &&
      !writing &&
      !readingBytes &&
      operation !== "storage.readText"
    ) {
      throw new BunawayError({
        code: "UNSUPPORTED",
        message: "Unknown storage operation.",
      });
    }
    const text = writingText && "text" in input ? input.text : undefined;
    if (writingText && text === undefined) {
      throw new BunawayError({
        code: "INVALID_ARGUMENT",
        message: "Storage text is required.",
      });
    }
    let bytes: Buffer | undefined;
    if (writingBytes && "bytes" in input) {
      bytes = Buffer.from(input.bytes, "base64");
    } else if (text !== undefined) {
      bytes = Buffer.from(text);
    }
    if (writingBytes && bytes === undefined) {
      throw new BunawayError({
        code: "INVALID_ARGUMENT",
        message: "Storage bytes are required.",
      });
    }
    const volume = win32.parse(path).root;
    const segments = path.slice(volume.length).split("\\");
    if (
      !/^(?:[A-Za-z]:\\|\\\\[^\\]+\\[^\\]+\\)$/.test(volume) ||
      path.startsWith("\\\\?\\") ||
      path.startsWith("\\\\.\\") ||
      !segments.length ||
      segments.some(
        (part) =>
          !part ||
          part === "." ||
          part === ".." ||
          Buffer.byteLength(part) > MAX_STORAGE_PATH_SEGMENT_BYTES ||
          /[<>:"|?*\\]/.test(part) ||
          [
            ...part,
          ].some((character) => character.charCodeAt(0) < 32) ||
          /[ .]$/.test(part),
      )
    ) {
      throw new BunawayError({
        code: "INVALID_ARGUMENT",
        message: "Invalid storage path.",
      });
    }
    const parents: bigint[] = [];
    let file = 0n;
    try {
      let root = "";
      let dir = volume;
      // Attribute-only handles ignore sharing restrictions; directory data access pins parents.
      for (let index = 0; index < segments.length; index++) {
        if (index) {
          dir += `\\${segments[index - 1]}`;
          if (
            writing &&
            !this.api.symbols.CreateDirectoryW(ptr(wide(dir)), null) &&
            this.api.symbols.GetLastError() !== ERROR_ALREADY_EXISTS
          ) {
            this.fail("Storage directory creation failed");
          }
        }
        const parent = this.open(
          dir,
          FILE_READ_ATTRIBUTES | FILE_LIST_DIRECTORY,
          FILE_SHARE_READ,
          OPEN_EXISTING,
          DIRECTORY_OPEN_FLAGS,
          queryingMetadata,
        );
        if (!parent) {
          return operation === "storage.exists" ? false : null;
        }
        parents.push(parent);
        const attributes = this.info(parent).readUInt32LE(0);
        if (
          attributes & FILE_ATTRIBUTE_REPARSE_POINT ||
          !(attributes & FILE_ATTRIBUTE_DIRECTORY)
        ) {
          deny("Storage path is not a plain directory.");
        }
        const canonical = this.canonical(parent);
        if (index === 0) {
          root = canonical.replace(/\\$/, "");
          dir = root;
          // Bind the requested spelling to each pinned parent before creating the next child.
        } else if (canonical !== dir) {
          deny("Storage path must use its canonical spelling.");
        }
      }
      const target = `${root}\\${segments.join("\\")}`;
      let access = GENERIC_READ;
      if (queryingMetadata) {
        access = FILE_READ_ATTRIBUTES | FILE_READ_DATA;
      } else if (writing) {
        access = appending
          ? FILE_APPEND_DATA | FILE_READ_ATTRIBUTES
          : GENERIC_WRITE;
      }
      // Queries pin the target against deletion until its metadata and path are checked.
      file = this.open(
        target,
        access,
        queryingMetadata ? FILE_SHARE_READ | FILE_SHARE_WRITE : FILE_SHARE_ALL,
        writing ? OPEN_ALWAYS : OPEN_EXISTING,
        queryingMetadata ? DIRECTORY_OPEN_FLAGS : FILE_FLAG_OPEN_REPARSE_POINT,
        queryingMetadata,
      );
      if (!file) {
        return operation === "storage.exists" ? false : null;
      }
      const info = this.info(file);
      const attributes = info.readUInt32LE(0);
      const isDirectory = Boolean(attributes & FILE_ATTRIBUTE_DIRECTORY);
      if (
        attributes & FILE_ATTRIBUTE_REPARSE_POINT ||
        (!queryingMetadata && isDirectory) ||
        (!isDirectory && info.readUInt32LE(40) > MAX_FILE_LINK_COUNT)
      ) {
        deny("Storage target is not a plain file or directory.");
      }
      const actual = this.canonical(file);
      if (actual !== target) {
        deny("Storage path must use its canonical spelling.");
      }
      if (queryingMetadata) {
        return operation === "storage.exists" ? true : metadata(info);
      }
      const transferred = new Uint32Array(1);
      if (bytes !== undefined) {
        // Append-only handles place each native write at EOF. Replacement truncates only after writing.
        let offset = 0;
        while (offset < bytes.length) {
          this.check(
            this.api.symbols.WriteFile(
              file,
              ptr(bytes.subarray(offset)),
              Math.min(bytes.length - offset, MAX_IO_CHUNK_BYTES),
              ptr(transferred),
              null,
            ),
            "Storage write failed",
          );
          if (!transferred[0]) {
            throw new Error("Storage write made no progress");
          }
          offset += transferred[0];
        }
        if (!appending) {
          this.check(
            this.api.symbols.SetEndOfFile(file),
            "Storage truncate failed",
          );
        }
        return null;
      }
      const size = new BigInt64Array(1);
      this.check(
        this.api.symbols.GetFileSizeEx(file, ptr(size)),
        "Storage size failed",
      );
      if (
        size[0] === undefined ||
        size[0] < 0n ||
        size[0] >
          BigInt(readingBytes ? MAX_STORAGE_BYTES : MAX_STORAGE_FILE_BYTES)
      ) {
        throw new Error("Storage file too large");
      }
      const result = this.readBytes(file, Number(size[0]));
      return readingBytes
        ? result.toString("base64")
        : new TextDecoder("utf-8", {
            fatal: true,
            ignoreBOM: true,
          }).decode(result);
    } finally {
      if (file) {
        this.close(file);
      }
      for (const parent of parents.reverse()) {
        this.close(parent);
      }
    }
  }
  /** Strictly decode UTF-8 from a caller-owned handle, preserving BOM text. */
  readText(file: bigint, size: number): string {
    return new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(this.readBytes(file, size));
  }
  /** Read bounded bytes; the caller retains handle ownership. */
  private readBytes(file: bigint, size: number): Buffer {
    this.requireOpen();
    if (
      !Number.isSafeInteger(size) ||
      size < 0 ||
      size > MAX_STORAGE_FILE_BYTES
    ) {
      throw new Error("Storage file too large");
    }
    const bytes = Buffer.alloc(size);
    const transferred = new Uint32Array(1);
    let offset = 0;
    while (offset < bytes.length) {
      this.check(
        this.api.symbols.ReadFile(
          file,
          ptr(bytes.subarray(offset)),
          bytes.length - offset,
          ptr(transferred),
          null,
        ),
        "Storage read failed",
      );
      if (!transferred[0]) {
        throw new Error("Storage file changed during read");
      }
      offset += transferred[0];
    }
    return bytes;
  }
}
