import { dlopen, ptr } from "bun:ffi";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  BunawayError,
  type JsonValue,
  type NativeAdapter,
  type NativeEnvironment,
} from "@bunaway/plugin";
import type { StorageLocation, StorageWrite } from "./index.ts";

const MAX_STORAGE_PATH_SEGMENT_BYTES = 255;
const MAX_STORAGE_FILE_BYTES = 4 * 1024 * 1024;
const MAX_IO_CHUNK_BYTES = 1 << 20;
const BY_HANDLE_FILE_INFORMATION_BYTES = 52;
const FINAL_PATH_BUFFER_CHARS = 32768;
const WCHAR_BYTES = 2;

const ERROR_FILE_NOT_FOUND = 2;
const ERROR_PATH_NOT_FOUND = 3;
const ERROR_ALREADY_EXISTS = 183;
const FILE_ATTRIBUTE_DIRECTORY = 0x10;
const FILE_ATTRIBUTE_REPARSE_POINT = 0x400;
const MAX_FILE_LINK_COUNT = 1;
const GENERIC_READ = 0x80000000;
const GENERIC_WRITE = 0x40000000;
const FILE_READ_ATTRIBUTES = 0x80;
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
      const location = input as StorageLocation;
      return storage.execute(
        location.scope,
        location.path,
        operation === "storage.writeText"
          ? (input as StorageWrite).text
          : undefined,
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
    throw new Error(message);
  }
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
        throw new BunawayError({
          code: "INVALID_ARGUMENT",
          message: "Storage target not found.",
        });
      }
      throw new Error(`Storage open failed (${code})`);
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
    if (!length || length >= FINAL_PATH_BUFFER_CHARS) {
      throw new Error("Storage path check failed");
    }
    return text.subarray(0, length * WCHAR_BYTES).toString("utf16le");
  }
  execute(
    scope: StorageLocation["scope"],
    path: string,
    text?: string,
  ): string | null {
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
      // No write/delete sharing: every checked parent stays pinned through final I/O.
      for (let index = 0; index < segments.length; index++) {
        if (index) {
          dir += `\\${segments[index - 1]}`;
          if (
            text !== undefined &&
            !api.symbols.CreateDirectoryW(ptr(wide(dir)), null) &&
            api.symbols.GetLastError() !== ERROR_ALREADY_EXISTS
          ) {
            throw new Error("Storage directory creation failed");
          }
        }
        const parent = this.open(
          dir,
          FILE_READ_ATTRIBUTES,
          FILE_SHARE_READ,
          OPEN_EXISTING,
          DIRECTORY_OPEN_FLAGS,
        );
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
      file = this.open(
        target,
        text === undefined ? GENERIC_READ : GENERIC_WRITE,
        FILE_SHARE_ALL,
        text === undefined ? OPEN_EXISTING : OPEN_ALWAYS,
        FILE_FLAG_OPEN_REPARSE_POINT,
      );
      const info = this.info(file);
      if (
        info.readUInt32LE(0) &
          (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT) ||
        info.readUInt32LE(40) > MAX_FILE_LINK_COUNT
      ) {
        deny("Storage target is not a plain in-scope file.");
      }
      const actual = this.canonical(file);
      if (actual !== target) {
        deny("Storage path must use its canonical spelling.");
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
