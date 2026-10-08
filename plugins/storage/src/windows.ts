import { dlopen, ptr } from "bun:ffi";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  BunawayError,
  type JsonValue,
  type NativeAdapter,
  type NativeEnvironment,
} from "@bunaway/plugin";
import type {
  StorageLocation,
  StorageMetadata,
  StorageWrite,
} from "./index.ts";

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

export function createOperations(
  environment: NativeEnvironment,
): NativeAdapter {
  const storage = new ScopedStorage(environment.dataRoot);
  return {
    execute(operation: string, input: JsonValue): JsonValue {
      // The host registry has validated this operation's input before dispatch.
      return storage.execute(
        operation,
        input as StorageLocation | StorageWrite,
      );
    },
    dispose: disposeStorageBindings,
  };
}

function wide(text: string): Buffer {
  return Buffer.from(`${text}\0`, "utf16le");
}
const api = dlopen("kernel32.dll", {
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
function deny(message: string): never {
  throw new BunawayError({
    code: "PERMISSION_DENIED",
    message,
  });
}
function check(value: number | bigint, message: string): void {
  if (!value) {
    fail(message);
  }
}
function fail(message: string, code = api.symbols.GetLastError()): never {
  if (code === ERROR_ACCESS_DENIED) {
    deny("Storage access denied.");
  }
  throw new Error(`${message} (${code})`);
}
function fileTimeMs(info: Buffer, offset: number): number | null {
  const ticks = info.readBigUInt64LE(offset);
  return ticks === 0n
    ? null
    : Number(ticks / FILETIME_TICKS_PER_MS - WINDOWS_EPOCH_OFFSET_MS);
}
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
export class ScopedStorage {
  private readonly roots: Record<StorageLocation["scope"], string>;
  constructor(dataRoot: string) {
    const root = (name: string) => {
      const path = resolve(dataRoot, name);
      mkdirSync(path, {
        recursive: true,
      });
      const handle = this.open(
        path,
        0,
        FILE_SHARE_ALL,
        OPEN_EXISTING,
        DIRECTORY_OPEN_FLAGS,
      );
      try {
        if (this.info(handle).readUInt32LE(0) & FILE_ATTRIBUTE_REPARSE_POINT) {
          deny("Scope root must not be a link.");
        }
        return this.canonical(handle);
      } finally {
        this.close(handle);
      }
    };
    this.roots = {
      appData: root("data"),
      temp: root("temp"),
    };
  }
  private close(handle: bigint) {
    check(api.symbols.CloseHandle(handle), "CloseHandle failed");
  }
  private open(
    path: string,
    access: number,
    share: number,
    disposition: number,
    flags: number,
    allowMissing = false,
  ): bigint {
    const handle = api.symbols.CreateFileW(
      ptr(wide(path)),
      access,
      share,
      null,
      disposition,
      flags,
      0n,
    );
    if (handle === 0n || handle === 0xffffffffffffffffn) {
      const code = api.symbols.GetLastError();
      if (code === ERROR_FILE_NOT_FOUND || code === ERROR_PATH_NOT_FOUND) {
        if (allowMissing) {
          return 0n;
        }
        throw new BunawayError({
          code: "INVALID_ARGUMENT",
          message: "Storage target not found.",
        });
      }
      fail("Storage open failed", code);
    }
    return handle;
  }
  private info(handle: bigint) {
    const info = Buffer.alloc(BY_HANDLE_FILE_INFORMATION_BYTES);
    check(
      api.symbols.GetFileInformationByHandle(handle, ptr(info)),
      "Storage stat failed",
    );
    return info;
  }
  private canonical(handle: bigint) {
    const text = Buffer.alloc(FINAL_PATH_BUFFER_CHARS * WCHAR_BYTES);
    const length = api.symbols.GetFinalPathNameByHandleW(
      handle,
      ptr(text),
      FINAL_PATH_BUFFER_CHARS,
      0,
    );
    if (!length) {
      fail("Storage path check failed");
    }
    if (length >= FINAL_PATH_BUFFER_CHARS) {
      throw new Error("Storage path check failed");
    }
    return text.subarray(0, length * WCHAR_BYTES).toString("utf16le");
  }
  execute(operation: string, input: StorageLocation | StorageWrite): JsonValue {
    const { scope, path } = input;
    const queryingMetadata =
      operation === "storage.exists" || operation === "storage.stat";
    const writingText = operation === "storage.writeText";
    if (!queryingMetadata && !writingText && operation !== "storage.readText") {
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
    const segments = path.split("/");
    if (
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
    const root = this.roots[scope];
    if (!root) {
      deny("Unknown storage scope.");
    }
    const parents: bigint[] = [];
    let file = 0n;
    try {
      let dir = root;
      // Attribute-only handles ignore sharing restrictions; directory data access pins parents.
      for (let index = 0; index < segments.length; index++) {
        if (index) {
          dir += `\\${segments[index - 1]}`;
          if (
            text !== undefined &&
            !api.symbols.CreateDirectoryW(ptr(wide(dir)), null) &&
            api.symbols.GetLastError() !== ERROR_ALREADY_EXISTS
          ) {
            fail("Storage directory creation failed");
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
        // Bind policy spelling to each pinned directory before creating the next child.
        if (this.canonical(parent) !== dir) {
          deny("Storage path must use its canonical spelling.");
        }
      }
      const target = `${root}\\${segments.join("\\")}`;
      let access = GENERIC_READ;
      if (queryingMetadata) {
        access = FILE_READ_ATTRIBUTES | FILE_READ_DATA;
      } else if (writingText) {
        access = GENERIC_WRITE;
      }
      // Queries pin the target against deletion until its metadata and path are checked.
      file = this.open(
        target,
        access,
        queryingMetadata ? FILE_SHARE_READ | FILE_SHARE_WRITE : FILE_SHARE_ALL,
        writingText ? OPEN_ALWAYS : OPEN_EXISTING,
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
        deny("Storage target is not a plain in-scope target.");
      }
      const actual = this.canonical(file);
      if (actual !== target) {
        deny("Storage path must use its canonical spelling.");
      }
      if (queryingMetadata) {
        return operation === "storage.exists" ? true : metadata(info);
      }
      const transferred = new Uint32Array(1);
      if (text !== undefined) {
        const bytes = Buffer.from(text);
        let offset = 0;
        while (offset < bytes.length) {
          check(
            api.symbols.WriteFile(
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
        check(api.symbols.SetEndOfFile(file), "Storage truncate failed");
        return null;
      }
      const size = new BigInt64Array(1);
      check(api.symbols.GetFileSizeEx(file, ptr(size)), "Storage size failed");
      if (
        size[0] === undefined ||
        size[0] < 0n ||
        size[0] > BigInt(MAX_STORAGE_FILE_BYTES)
      ) {
        throw new Error("Storage file too large");
      }
      return readStorageText(file, Number(size[0]));
    } finally {
      if (file) {
        this.close(file);
      }
      for (const parent of parents.reverse()) {
        this.close(parent);
      }
    }
  }
}
export function disposeStorageBindings() {
  api.close();
}

export function readStorageText(file: bigint, size: number): string {
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
    check(
      api.symbols.ReadFile(
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
  return new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: true,
  }).decode(bytes);
}
