import { dlopen, ptr } from "bun:ffi";
import { KERNEL32, pick } from "@bunaway/plugin/win32";
import { win32 } from "node:path";
import { BunawayError } from "@bunaway/plugin";
import {
  MAX_DIRECTORY_ENTRIES,
  MAX_STORAGE_BYTES,
  type StorageBytesWrite,
  type StorageDirectoryCreate,
  type StorageDirectoryEntry,
  type StorageLocation,
  type StorageMetadata,
  type StorageTransfer,
  type StorageWrite,
} from "#storage/contract";
import { directoryEntries } from "#storage/platforms/windows-directory-entries";

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
const ERROR_NO_MORE_FILES = 18;
const ERROR_DIR_NOT_EMPTY = 145;
const FILE_ID_BOTH_DIRECTORY_INFO = 10;
const FILE_ID_BOTH_DIRECTORY_RESTART_INFO = 11;
const DIRECTORY_BUFFER_BYTES = 64 * 1024;
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
const DELETE = 0x10000;
const SYNCHRONIZE = 0x100000;
const CREATE_NEW = 1;
const ERROR_FILE_EXISTS = 80;
const ERROR_NOT_SAME_DEVICE = 17;
const FILE_RENAME_INFORMATION = 10;
const FILE_DISPOSITION_INFO = 4;
const FILE_RENAME_INFO_BYTES = 24;
const FILE_RENAME_NAME_LENGTH_OFFSET = 16;
const FILE_RENAME_NAME_OFFSET = 20;
const OPEN_EXISTING = 3;
const OPEN_ALWAYS = 4;
const FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
const FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
const DIRECTORY_OPEN_FLAGS =
  FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS;
const UNICODE_STRING_BYTES = 16;
const HANDLE_BYTES = 8;
const IO_STATUS_BLOCK_BYTES = 16;
const OBJECT_ATTRIBUTES_BYTES = 48;
const OBJECT_NAME_OFFSET = 16;
const OBJECT_ATTRIBUTES_FLAGS_OFFSET = 24;
const OBJ_CASE_INSENSITIVE = 0x40;
const FILE_ATTRIBUTE_NORMAL = 0x80;
const FILE_OPEN = 1;
const FILE_CREATE = 2;
const FILE_OPEN_IF = 3;
const NATIVE_FILE_DISPOSITIONS = {
  [CREATE_NEW]: FILE_CREATE,
  [OPEN_EXISTING]: FILE_OPEN,
  [OPEN_ALWAYS]: FILE_OPEN_IF,
};
type FileDisposition = keyof typeof NATIVE_FILE_DISPOSITIONS;
const FILE_SYNCHRONOUS_IO_NONALERT = 0x20;
const FILE_NON_DIRECTORY_FILE = 0x40;
const FILE_OPEN_FOR_BACKUP_INTENT = 0x4000;
const FILE_OPEN_REPARSE_POINT = 0x200000;

/** Initialize bindings only when the host activates this platform instance. */
export function createStorage(): WindowsStorage {
  return new WindowsStorage();
}

/** Release the bindings owned by one host instance. */
export function disposeStorage(storage: WindowsStorage): void {
  storage.dispose();
}
function wide(text: string): Buffer {
  return Buffer.from(`${text}\0`, "utf16le");
}
function createBindings() {
  return dlopen("kernel32.dll", {
    ...pick(
      KERNEL32,
      "GetLastError",
      "GetFileInformationByHandle",
      "GetFinalPathNameByHandleW",
      "ReadFile",
      "WriteFile",
      "CloseHandle",
    ),
    CreateDirectoryW: {
      args: [
        "ptr",
        "ptr",
      ],
      returns: "i32",
    },
    GetFileInformationByHandleEx: {
      args: [
        "u64",
        "u32",
        "ptr",
        "u32",
      ],
      returns: "i32",
    },
    SetFileInformationByHandle: {
      args: [
        "u64",
        "u32",
        "ptr",
        "u32",
      ],
      returns: "i32",
    },
    GetFileSizeEx: {
      args: [
        "u64",
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
  });
}
/** Native file operations return their status without a separate thread-local error read. */
function createFileBindings() {
  return dlopen("ntdll.dll", {
    RtlDosPathNameToNtPathName_U_WithStatus: {
      args: [
        "buffer",
        "buffer",
        "ptr",
        "ptr",
      ],
      returns: "i32",
    },
    RtlFreeUnicodeString: {
      args: [
        "buffer",
      ],
      returns: "void",
    },
    NtCreateFile: {
      args: [
        "buffer",
        "u32",
        "buffer",
        "buffer",
        "ptr",
        "u32",
        "u32",
        "u32",
        "u32",
        "ptr",
        "u32",
      ],
      returns: "i32",
    },
    NtSetInformationFile: {
      args: [
        "u64",
        "ptr",
        "ptr",
        "u32",
        "u32",
      ],
      returns: "i32",
    },
    RtlNtStatusToDosError: {
      args: [
        "u32",
      ],
      returns: "u32",
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
/** Validate raw app-selected spelling before resolving either transfer endpoint. */
function selectedPath(path: string) {
  path = path.replaceAll("/", "\\");
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
  return {
    path,
    volume,
    segments,
  };
}
type TargetOptions = {
  access: number;
  share: number;
  disposition: FileDisposition;
  allowDirectories: boolean;
  allowMissing: boolean;
  createParents: boolean;
  /** Create this target under pinned parents before its checked OPEN_EXISTING. */
  createDirectory?: boolean;
};
const METADATA_TARGET_OPTIONS: TargetOptions = {
  access: FILE_READ_ATTRIBUTES | FILE_READ_DATA,
  share: FILE_SHARE_READ | FILE_SHARE_WRITE,
  disposition: OPEN_EXISTING,
  allowDirectories: true,
  allowMissing: true,
  createParents: false,
};
/** Transfers pin object identity and exclude new writers; destination creation never overwrites. */
function transferOptions(
  access: number,
  disposition: FileDisposition,
): TargetOptions {
  return {
    access,
    share: FILE_SHARE_READ,
    disposition,
    allowDirectories: false,
    allowMissing: false,
    createParents: false,
  };
}
export class WindowsStorage {
  private readonly api = createBindings();
  private disposed = false;
  private fileApi: ReturnType<typeof createFileBindings> | null = null;
  /** Release this instance's bindings; other storage adapters retain their resources. */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.fileApi?.close();
    this.fileApi = null;
    this.api.close();
  }
  private check(value: number | bigint, message: string): void {
    if (!value) {
      this.fail(message);
    }
  }
  private fail(message: string, code = this.api.symbols.GetLastError()): never {
    if (code === ERROR_FILE_EXISTS || code === ERROR_ALREADY_EXISTS) {
      throw new BunawayError({
        code: "INVALID_ARGUMENT",
        message: "Storage destination already exists.",
      });
    }
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
  /** Preserve synchronous CreateFileW access/sharing semantics while capturing failure as NTSTATUS. */
  private open(
    path: string,
    access: number,
    share: number,
    disposition: FileDisposition,
    flags: number,
    allowMissing = false,
  ): bigint {
    this.fileApi ??= createFileBindings();
    const api = this.fileApi;
    const name = Buffer.alloc(UNICODE_STRING_BYTES);
    const handle = Buffer.alloc(HANDLE_BYTES);
    const converted = api.symbols.RtlDosPathNameToNtPathName_U_WithStatus(
      wide(path),
      name,
      null,
      null,
    );
    if (converted < 0) {
      this.fail(
        "Storage path conversion failed",
        api.symbols.RtlNtStatusToDosError(converted >>> 0),
      );
    }
    let status: number;
    try {
      const attributes = Buffer.alloc(OBJECT_ATTRIBUTES_BYTES);
      attributes.writeUInt32LE(OBJECT_ATTRIBUTES_BYTES);
      attributes.writeBigUInt64LE(BigInt(ptr(name)), OBJECT_NAME_OFFSET);
      attributes.writeUInt32LE(
        OBJ_CASE_INSENSITIVE,
        OBJECT_ATTRIBUTES_FLAGS_OFFSET,
      );
      const statusBlock = Buffer.alloc(IO_STATUS_BLOCK_BYTES);
      // CreateFileW's u64 result is boxed by Bun before JS can read GetLastError.
      // That allocation (or a cold error-reader thunk) can overwrite the error.
      // Receive the handle in caller-owned memory and use the returned NTSTATUS.
      // CreateFileW also requests attribute reads and synchronization, including for write-only opens.
      status = api.symbols.NtCreateFile(
        handle,
        access | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
        attributes,
        statusBlock,
        null,
        FILE_ATTRIBUTE_NORMAL,
        share,
        NATIVE_FILE_DISPOSITIONS[disposition],
        FILE_SYNCHRONOUS_IO_NONALERT |
          FILE_OPEN_REPARSE_POINT |
          (flags & FILE_FLAG_BACKUP_SEMANTICS
            ? FILE_OPEN_FOR_BACKUP_INTENT
            : FILE_NON_DIRECTORY_FILE),
        null,
        0,
      );
    } finally {
      api.symbols.RtlFreeUnicodeString(name);
    }
    if (status < 0) {
      const code = api.symbols.RtlNtStatusToDosError(status >>> 0);
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
    const opened = handle.readBigUInt64LE(0);
    if (opened === 0n || opened === 0xffffffffffffffffn) {
      throw new Error("Storage open returned an invalid handle.");
    }
    return opened;
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
  /** Read bounded UTF-8 text from a checked, pinned file. */
  readText(input: StorageLocation): string {
    return new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(this.readFile(input.path, MAX_STORAGE_FILE_BYTES));
  }

  /** Read bounded file bytes as canonical base64. */
  readBytes(input: StorageLocation): string {
    return this.readFile(input.path, MAX_STORAGE_BYTES).toString("base64");
  }

  /** Replace text and truncate any previous tail after writing. */
  writeText(input: StorageWrite): null {
    return this.writeFile(input.path, Buffer.from(input.text), false);
  }

  /** Append UTF-8 text using an append-only native handle. */
  appendText(input: StorageWrite): null {
    return this.writeFile(input.path, Buffer.from(input.text), true);
  }

  /** Replace bytes and truncate any previous tail after writing. */
  writeBytes(input: StorageBytesWrite): null {
    return this.writeFile(
      input.path,
      Buffer.from(input.bytes, "base64"),
      false,
    );
  }

  /** Append bytes using an append-only native handle. */
  appendBytes(input: StorageBytesWrite): null {
    return this.writeFile(input.path, Buffer.from(input.bytes, "base64"), true);
  }

  /** Missing targets return false; invalid paths and access failures still throw. */
  exists(input: StorageLocation): boolean {
    return (
      this.withFile(input.path, METADATA_TARGET_OPTIONS, () => true) !== null
    );
  }

  /** Missing targets return null; metadata is read from the checked handle. */
  stat(input: StorageLocation): StorageMetadata | null {
    return this.withFile(input.path, METADATA_TARGET_OPTIONS, ({ info }) =>
      metadata(info),
    );
  }

  /** List one checked directory without following links or reopening it by name. */
  readDirectory(input: StorageLocation): StorageDirectoryEntry[] {
    const result = this.withFile(
      input.path,
      {
        ...METADATA_TARGET_OPTIONS,
        allowMissing: false,
      },
      ({ handle, info }) => {
        this.requireDirectory(info);
        return this.listEntries(handle);
      },
    );
    if (result === null) {
      throw new Error("Storage directory was not opened.");
    }
    return result;
  }

  /** Create the selected directory, optionally preparing its parents under pinned handles. */
  createDirectory(input: StorageDirectoryCreate): null {
    this.withFile(
      input.path,
      {
        ...METADATA_TARGET_OPTIONS,
        allowMissing: false,
        createParents: input.recursive,
        createDirectory: true,
      },
      ({ info }) => {
        this.requireDirectory(info);
        return null;
      },
    );
    return null;
  }

  /** Delete only the checked object; nonempty directories remain intact. */
  remove(input: StorageLocation): null {
    this.withFile(
      input.path,
      {
        ...METADATA_TARGET_OPTIONS,
        access: DELETE | FILE_READ_ATTRIBUTES | FILE_READ_DATA,
        allowMissing: false,
      },
      ({ handle }) => {
        const disposition = new Uint8Array([
          1,
        ]);
        if (
          !this.api.symbols.SetFileInformationByHandle(
            handle,
            FILE_DISPOSITION_INFO,
            ptr(disposition),
            disposition.byteLength,
          )
        ) {
          const error = this.api.symbols.GetLastError();
          if (error === ERROR_DIR_NOT_EMPTY) {
            throw new BunawayError({
              code: "INVALID_ARGUMENT",
              message: "Storage directory is not empty.",
            });
          }
          this.fail("Storage removal failed", error);
        }
        return null;
      },
    );
    return null;
  }

  private requireDirectory(info: Buffer): void {
    if (!(info.readUInt32LE(0) & FILE_ATTRIBUTE_DIRECTORY)) {
      throw new BunawayError({
        code: "INVALID_ARGUMENT",
        message: "Storage target is not a directory.",
      });
    }
  }

  /** Open and bound the file before reading; all handles stay pinned until completion. */
  private readFile(path: string, maxBytes: number): Buffer {
    const result = this.withFile(
      path,
      {
        access: GENERIC_READ,
        share: FILE_SHARE_ALL,
        disposition: OPEN_EXISTING,
        allowDirectories: false,
        allowMissing: false,
        createParents: false,
      },
      ({ handle }) => {
        const size = new BigInt64Array(1);
        this.check(
          this.api.symbols.GetFileSizeEx(handle, ptr(size)),
          "Storage size failed",
        );
        if (
          size[0] === undefined ||
          size[0] < 0n ||
          size[0] > BigInt(maxBytes)
        ) {
          throw new Error("Storage file too large");
        }
        return this.readFileBytes(handle, Number(size[0]));
      },
    );
    if (result === null) {
      throw new Error("Storage file was not opened.");
    }
    return result;
  }

  /** Share checked-handle writes while preserving append and replacement semantics. */
  private writeFile(path: string, bytes: Buffer, append: boolean): null {
    this.withFile(
      path,
      {
        access: append
          ? FILE_APPEND_DATA | FILE_READ_ATTRIBUTES
          : GENERIC_WRITE,
        share: FILE_SHARE_ALL,
        disposition: OPEN_ALWAYS,
        allowDirectories: false,
        allowMissing: false,
        createParents: true,
      },
      ({ handle }) => {
        this.writeFileBytes(handle, bytes);
        if (!append) {
          this.check(
            this.api.symbols.SetEndOfFile(handle),
            "Storage truncate failed",
          );
        }
        return null;
      },
    );
    return null;
  }
  /** Pin and inspect every parent, including the volume, until the owned action finishes. */
  private withParent<T>(
    path: string,
    createParents: boolean,
    allowMissing: boolean,
    action: (parent: { target: string }) => T,
  ): T | null {
    this.requireOpen();
    const { volume, segments } = selectedPath(path);
    const parents: bigint[] = [];
    try {
      let root = "";
      let dir = volume;
      // Attribute-only handles ignore sharing restrictions; directory data access pins parents.
      for (let index = 0; index < segments.length; index++) {
        if (index) {
          dir += `\\${segments[index - 1]}`;
          if (
            createParents &&
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
          allowMissing,
        );
        if (!parent) {
          return null;
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
      return action({
        target,
      });
    } finally {
      for (const parent of parents.reverse()) {
        this.close(parent);
      }
    }
  }

  /** Open, pin and validate one target under pinned parents, then close it before releasing them. */
  private withFile<T>(
    path: string,
    options: TargetOptions,
    action: (target: { handle: bigint; canonical: string; info: Buffer }) => T,
  ): T | null {
    return this.withParent(
      path,
      options.createParents,
      options.allowMissing,
      ({ target }) => {
        if (
          options.createDirectory &&
          !this.api.symbols.CreateDirectoryW(ptr(wide(target)), null) &&
          this.api.symbols.GetLastError() !== ERROR_ALREADY_EXISTS
        ) {
          this.fail("Storage directory creation failed");
        }
        const handle = this.open(
          target,
          options.access,
          options.share,
          options.disposition,
          options.allowDirectories
            ? DIRECTORY_OPEN_FLAGS
            : FILE_FLAG_OPEN_REPARSE_POINT,
          options.allowMissing,
        );
        if (!handle) {
          return null;
        }
        try {
          const info = this.info(handle);
          const attributes = info.readUInt32LE(0);
          const isDirectory = Boolean(attributes & FILE_ATTRIBUTE_DIRECTORY);
          if (
            attributes & FILE_ATTRIBUTE_REPARSE_POINT ||
            (!options.allowDirectories && isDirectory) ||
            (!isDirectory && info.readUInt32LE(40) > MAX_FILE_LINK_COUNT)
          ) {
            deny("Storage target is not a plain file or directory.");
          }
          const canonical = this.canonical(handle);
          if (canonical !== target) {
            deny("Storage path must use its canonical spelling.");
          }
          return action({
            handle,
            canonical,
            info,
          });
        } finally {
          this.close(handle);
        }
      },
    );
  }

  private size(handle: bigint): number {
    const size = new BigInt64Array(1);
    this.check(
      this.api.symbols.GetFileSizeEx(handle, ptr(size)),
      "Storage size failed",
    );
    if (
      size[0] === undefined ||
      size[0] < 0n ||
      size[0] > BigInt(MAX_STORAGE_FILE_BYTES)
    ) {
      throw new BunawayError({
        code: "INVALID_ARGUMENT",
        message: "Storage file exceeds the bounded I/O limit.",
      });
    }
    return Number(size[0]);
  }

  /** Make progress on partial native writes, reusing the same checked target handle. */
  private writeFileBytes(handle: bigint, bytes: Buffer): void {
    const transferred = new Uint32Array(1);
    let offset = 0;
    while (offset < bytes.length) {
      this.check(
        this.api.symbols.WriteFile(
          handle,
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
  }

  /** Copy a bounded file without overwriting or reopening either checked object by name. */
  copyFile(input: StorageTransfer): null {
    this.withFile(
      input.from,
      transferOptions(GENERIC_READ, OPEN_EXISTING),
      (source) => {
        // Check the bound before creating the destination. Existing writers and renames are excluded.
        const size = this.size(source.handle);
        this.withFile(
          input.to,
          transferOptions(GENERIC_WRITE | DELETE, CREATE_NEW),
          (destination) => {
            try {
              const buffer = Buffer.alloc(
                Math.max(1, Math.min(size, MAX_IO_CHUNK_BYTES)),
              );
              const transferred = new Uint32Array(1);
              let remaining = size;
              while (remaining > 0) {
                this.check(
                  this.api.symbols.ReadFile(
                    source.handle,
                    ptr(buffer),
                    Math.min(remaining, buffer.length),
                    ptr(transferred),
                    null,
                  ),
                  "Storage copy read failed",
                );
                if (!transferred[0]) {
                  throw new Error("Storage file changed during copy");
                }
                this.writeFileBytes(
                  destination.handle,
                  buffer.subarray(0, transferred[0]),
                );
                remaining -= transferred[0];
              }
            } catch (error) {
              // Only our newly created, still-pinned destination may be cleaned up. The source is retained.
              const disposition = new Uint8Array([
                1,
              ]);
              if (
                !this.api.symbols.SetFileInformationByHandle(
                  destination.handle,
                  FILE_DISPOSITION_INFO,
                  ptr(disposition),
                  disposition.byteLength,
                )
              ) {
                const cleanup = new Error(
                  `Storage copy cleanup failed (${this.api.symbols.GetLastError()})`,
                );
                cleanup.cause = error;
                throw cleanup;
              }
              throw error;
            }
            return null;
          },
        );
        return null;
      },
    );
    return null;
  }

  /** Rename the checked source in its pinned parent, with atomic no-replace semantics. */
  move(input: StorageTransfer): null {
    const from = selectedPath(input.from).path;
    const to = selectedPath(input.to).path;
    if (to.toUpperCase().startsWith(`${from.toUpperCase()}\\`)) {
      throw new BunawayError({
        code: "INVALID_ARGUMENT",
        message: "Cannot move a directory into itself.",
      });
    }
    this.withFile(
      input.from,
      {
        ...transferOptions(
          DELETE | SYNCHRONIZE | FILE_READ_ATTRIBUTES | FILE_READ_DATA,
          OPEN_EXISTING,
        ),
        allowDirectories: true,
      },
      (source) => {
        this.withParent(input.to, false, false, (destination) => {
          if (source.canonical === destination.target) {
            throw new BunawayError({
              code: "INVALID_ARGUMENT",
              message: "Move source and destination are the same.",
            });
          }
          if (
            win32.dirname(source.canonical) !==
            win32.dirname(destination.target)
          ) {
            throw new BunawayError({
              code: "UNSUPPORTED",
              message:
                "Storage move currently requires the same parent directory.",
            });
          }
          // Windows can report a sharing violation before a no-replace name collision.
          // Recognize a checked existing target explicitly; a later race still cannot replace it.
          const exists = this.withFile(
            input.to,
            {
              access: FILE_READ_ATTRIBUTES | FILE_READ_DATA,
              share: FILE_SHARE_READ | FILE_SHARE_WRITE,
              disposition: OPEN_EXISTING,
              allowDirectories: true,
              allowMissing: true,
              createParents: false,
            },
            () => true,
          );
          if (exists) {
            throw new BunawayError({
              code: "INVALID_ARGUMENT",
              message: "Storage destination already exists.",
            });
          }
          // A simple NT name with RootDirectory=NULL renames within the source's parent.
          // An absolute/cross-directory rename reopens a parent for write, conflicting with
          // the write-denying data handles that prevent reparse mutation and replacement races.
          const name = Buffer.from(
            win32.basename(destination.target),
            "utf16le",
          );
          const rename = Buffer.alloc(FILE_RENAME_INFO_BYTES + name.length);
          rename.writeUInt32LE(name.length, FILE_RENAME_NAME_LENGTH_OFFSET);
          name.copy(rename, FILE_RENAME_NAME_OFFSET);
          const statusBlock = Buffer.alloc(IO_STATUS_BLOCK_BYTES);
          this.fileApi ??= createFileBindings();
          const api = this.fileApi;
          // Opening with FILE_SYNCHRONOUS_IO_NONALERT creates a synchronous file object. Buffers and all
          // pins stay alive until NtSetInformationFile has completed the native operation.
          const status = api.symbols.NtSetInformationFile(
            source.handle,
            ptr(statusBlock),
            ptr(rename),
            rename.length,
            FILE_RENAME_INFORMATION,
          );
          if (status < 0) {
            const error = api.symbols.RtlNtStatusToDosError(status >>> 0);
            if (error === ERROR_NOT_SAME_DEVICE) {
              throw new BunawayError({
                code: "UNSUPPORTED",
                message: "Storage move requires the same filesystem volume.",
              });
            }
            this.fail("Storage move failed", error);
          }
          return null;
        });
        return null;
      },
    );
    return null;
  }
  /** Enumerate the already checked directory handle, with no path-based reopening or link following. */
  private listEntries(handle: bigint): StorageDirectoryEntry[] {
    const buffer = Buffer.alloc(DIRECTORY_BUFFER_BYTES);
    const entries: StorageDirectoryEntry[] = [];
    let informationClass = FILE_ID_BOTH_DIRECTORY_RESTART_INFO;
    while (true) {
      buffer.fill(0);
      if (
        !this.api.symbols.GetFileInformationByHandleEx(
          handle,
          informationClass,
          ptr(buffer),
          buffer.length,
        )
      ) {
        const error = this.api.symbols.GetLastError();
        if (error === ERROR_NO_MORE_FILES) {
          return entries.sort((left, right) =>
            left.name < right.name ? -1 : Number(left.name > right.name),
          );
        }
        this.fail("Storage directory listing failed", error);
      }
      informationClass = FILE_ID_BOTH_DIRECTORY_INFO;
      const batch = directoryEntries(buffer);
      if (entries.length + batch.length > MAX_DIRECTORY_ENTRIES) {
        throw new BunawayError({
          code: "INVALID_ARGUMENT",
          message: "Storage directory exceeds the entry limit.",
        });
      }
      entries.push(...batch);
    }
  }
  /** Strictly decode UTF-8 from a caller-owned handle, preserving BOM text. */
  readTextFromHandle(file: bigint, size: number): string {
    return new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(this.readFileBytes(file, size));
  }
  /** Read bounded bytes; the caller retains handle ownership. */
  private readFileBytes(file: bigint, size: number): Buffer {
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
