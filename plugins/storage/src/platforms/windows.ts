import { dlopen, ptr } from "bun:ffi";
import { win32 } from "node:path";
import {
  BunawayError,
  type JsonValue,
  type NativeAdapter,
} from "@bunaway/plugin";
import { MAX_STORAGE_BYTES } from "../bytes.ts";
import type {
  StorageBytesWrite,
  StorageDirectoryCreate,
  StorageLocation,
  StorageMetadata,
  StorageTransfer,
  StorageWrite,
} from "../contract.ts";
import {
  directoryEntries,
  MAX_DIRECTORY_ENTRIES,
  type StorageDirectoryEntry,
} from "../directory-entries.ts";

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

/** Create the I/O adapter and tie native binding cleanup to its host lifecycle. */
export function createOperations(): NativeAdapter {
  const storage = new WindowsStorage();
  return {
    execute(operation: string, input: JsonValue): JsonValue {
      // The host registry has validated this operation's input before dispatch.
      return storage.execute(
        operation,
        input as
          | StorageLocation
          | StorageWrite
          | StorageBytesWrite
          | StorageDirectoryCreate
          | StorageTransfer,
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
/** Native rename accepts a simple name relative to the source's already opened parent. */
function createRenameBindings() {
  return dlopen("ntdll.dll", {
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
  disposition: number;
  allowDirectories: boolean;
  allowMissing: boolean;
  createParents: boolean;
  /** Create this target under pinned parents before its checked OPEN_EXISTING. */
  createDirectory?: boolean;
};
/** Transfers pin object identity and exclude new writers; destination creation never overwrites. */
function transferOptions(access: number, disposition: number): TargetOptions {
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
  private renameApi: ReturnType<typeof createRenameBindings> | null = null;
  /** Release this instance's bindings; other storage adapters retain their resources. */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.renameApi?.close();
    this.renameApi = null;
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
  /** Check both endpoints under the same path rules; the host grants the named operation once. */
  execute(
    operation: string,
    input:
      | StorageLocation
      | StorageWrite
      | StorageBytesWrite
      | StorageDirectoryCreate
      | StorageTransfer,
  ): JsonValue {
    this.requireOpen();
    if ("from" in input) {
      if (operation === "storage.copyFile") {
        return this.copyFile(input);
      }
      if (operation === "storage.move") {
        return this.move(input);
      }
      throw new BunawayError({
        code: "UNSUPPORTED",
        message: "Unknown storage operation.",
      });
    }
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
    const listingDirectory = operation === "storage.readDirectory";
    const creatingDirectory = operation === "storage.createDirectory";
    const removing = operation === "storage.remove";
    const directoryOperation = listingDirectory || creatingDirectory;
    const allowsDirectory = queryingMetadata || directoryOperation || removing;
    if (
      !allowsDirectory &&
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
    let access = GENERIC_READ;
    if (removing) {
      access = DELETE | FILE_READ_ATTRIBUTES | FILE_READ_DATA;
    } else if (queryingMetadata || directoryOperation) {
      access = FILE_READ_ATTRIBUTES | FILE_READ_DATA;
    } else if (writing) {
      access = appending
        ? FILE_APPEND_DATA | FILE_READ_ATTRIBUTES
        : GENERIC_WRITE;
    }
    const result = this.withFile(
      input.path,
      {
        access,
        share: allowsDirectory
          ? FILE_SHARE_READ | FILE_SHARE_WRITE
          : FILE_SHARE_ALL,
        disposition: writing ? OPEN_ALWAYS : OPEN_EXISTING,
        allowDirectories: allowsDirectory,
        allowMissing: queryingMetadata,
        createParents:
          writing ||
          (creatingDirectory && "recursive" in input && input.recursive),
        createDirectory: creatingDirectory,
      },
      ({ handle, info }) => {
        if (queryingMetadata) {
          return operation === "storage.exists" ? true : metadata(info);
        }
        if (
          directoryOperation &&
          !(info.readUInt32LE(0) & FILE_ATTRIBUTE_DIRECTORY)
        ) {
          throw new BunawayError({
            code: "INVALID_ARGUMENT",
            message: "Storage target is not a directory.",
          });
        }
        if (creatingDirectory) {
          return null;
        }
        if (listingDirectory) {
          return this.readDirectory(handle);
        }
        if (removing) {
          // Delete only the checked object while its handle and every parent remain pinned.
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
        }
        if (bytes !== undefined) {
          // Append-only handles place each write at EOF; replacement truncates after writing.
          this.writeBytes(handle, bytes);
          if (!appending) {
            this.check(
              this.api.symbols.SetEndOfFile(handle),
              "Storage truncate failed",
            );
          }
          return null;
        }
        const size = new BigInt64Array(1);
        this.check(
          this.api.symbols.GetFileSizeEx(handle, ptr(size)),
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
        const result = this.readBytes(handle, Number(size[0]));
        return readingBytes
          ? result.toString("base64")
          : new TextDecoder("utf-8", {
              fatal: true,
              ignoreBOM: true,
            }).decode(result);
      },
    );
    return result === null && operation === "storage.exists" ? false : result;
  }

  /** Pin and inspect every parent, including the volume, until the owned action finishes. */
  private withParent<T extends JsonValue>(
    path: string,
    createParents: boolean,
    allowMissing: boolean,
    action: (parent: { target: string }) => T,
  ): T | null {
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
  private withFile<T extends JsonValue>(
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
  private writeBytes(handle: bigint, bytes: Buffer): void {
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
  private copyFile(input: StorageTransfer): null {
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
                this.writeBytes(
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
  private move(input: StorageTransfer): null {
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
          const statusBlock = Buffer.alloc(16);
          this.renameApi ??= createRenameBindings();
          const api = this.renameApi;
          // CreateFileW without OVERLAPPED creates a synchronous file object. Buffers and all
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
  private readDirectory(handle: bigint): StorageDirectoryEntry[] {
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
