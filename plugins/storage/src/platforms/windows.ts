import { dlopen, ptr } from "bun:ffi";
import { win32 } from "node:path";
import { attemptAll, BunawayError, failWithCleanup } from "@bunaway/plugin";
import { KERNEL32, pick } from "@bunaway/plugin/win32";
import {
  MAX_DIRECTORY_ENTRIES,
  MAX_DIRECTORY_SIZE_DEPTH,
  MAX_DIRECTORY_SIZE_ENTRIES,
  type StorageDirectoryCreate,
  type StorageDirectoryEntry,
  type StorageDirectorySize,
  type StorageLocation,
  type StorageMetadata,
  type StorageTransfer,
  type WindowsStorageInstance,
} from "#storage/contract";
import { MAX_STORAGE_FILE_BYTES, StorageFiles } from "#storage/platforms/files";
import {
  directoryEntries,
  fileSizeBytes,
  type ScannedDirectoryEntry,
  scanDirectoryEntries,
  scanRole,
} from "#storage/platforms/windows-directory-entries";

const MAX_STORAGE_PATH_SEGMENT_BYTES = 255;
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
const STATUS_DELETE_PENDING = 0xc0000056;
const ERROR_DIR_NOT_EMPTY = 145;
const FILE_ID_BOTH_DIRECTORY_INFO = 10;
const FILE_ID_BOTH_DIRECTORY_RESTART_INFO = 11;
const DIRECTORY_BUFFER_BYTES = 64 * 1024;
const FILE_ATTRIBUTE_READONLY = 0x1;
const FILE_ATTRIBUTE_DIRECTORY = 0x10;
const FILE_ATTRIBUTE_REPARSE_POINT = 0x400;
const MAX_FILE_LINK_COUNT = 1;
const GENERIC_READ = 0x80000000;
const GENERIC_WRITE = 0x40000000;
const FILE_APPEND_DATA = 0x4;
const FILE_READ_ATTRIBUTES = 0x80;
const FILE_WRITE_ATTRIBUTES = 0x100;
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
const FILE_DISPOSITION_INFO_EX = 21;
/** DELETE | POSIX_SEMANTICS | IGNORE_READONLY_ATTRIBUTE. */
const FILE_DISPOSITION_FORCE_FLAGS = 0x13;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_NOT_SUPPORTED = 50;
const ERROR_INVALID_FUNCTION = 1;
const FILE_BASIC_INFO = 0;
const FILE_BASIC_INFO_BYTES = 40;
const FILE_BASIC_ATTRIBUTES_OFFSET = 32;
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
export function disposeStorage(storage: WindowsStorage): Promise<void> {
  return storage.dispose();
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
  /** Sharing of the pinned parent directories; read-only sharing when omitted. */
  parentShare?: number;
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
/** Cost bounds of one directorySize call; only tests pass values other than the contract defaults. */
type DirectorySizeLimits = {
  entries: number;
  depth: number;
};
const DIRECTORY_SIZE_LIMITS: DirectorySizeLimits = {
  entries: MAX_DIRECTORY_SIZE_ENTRIES,
  depth: MAX_DIRECTORY_SIZE_DEPTH,
};
/** One open directory on the current walk path and the child directories still to visit. */
type DirectoryScanFrame = {
  handle: bigint;
  path: string;
  restart: boolean;
  pending: string[];
};
/** Running totals of one scan; visited counts every listed child against the entry limit. */
type DirectoryScanTotals = {
  bytes: bigint;
  files: number;
  directories: number;
  visited: number;
};
function directorySizeLimitExceeded(): BunawayError {
  return new BunawayError({
    code: "INVALID_ARGUMENT",
    message: "Storage directory exceeds the size scan limit.",
  });
}
const STORAGE_CLEANUP_MESSAGE = "Storage operation failed and cleanup failed.";
/** Walk steps (entry batches or directory opens) between event loop yields. */
const DIRECTORY_SIZE_YIELD_STEPS = 32;
/** Let queued host messages, such as cancellation, run before the scan continues. */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
/**
 * Run an action that may complete synchronously or asynchronously, then release its resources
 * exactly once. When the action fails, its error is rethrown after the release; if the release
 * fails too, the two errors are reported together as one INTERNAL error (the shared
 * failWithCleanup policy).
 */
function withRelease<T>(action: () => T, release: () => void): T {
  let result: T;
  try {
    result = action();
  } catch (error) {
    return failWithCleanup(error, release, STORAGE_CLEANUP_MESSAGE);
  }
  if (result instanceof Promise) {
    // T is the promise's own type, so the chained promise has the same shape.
    return result.then(
      (value) => {
        release();
        return value;
      },
      (error: unknown) =>
        failWithCleanup(error, release, STORAGE_CLEANUP_MESSAGE),
    ) as T;
  }
  release();
  return result;
}
/**
 * Add sized files to the totals, queue plain child directories and skip name surrogate links,
 * all bounded by the entry limit. Reparse point files that are not name surrogates, such as cloud
 * placeholders and deduplicated files, are data files with a logical size and are counted.
 * A non-surrogate reparse point directory fails the scan rather than being under-counted.
 */
function tallyEntries(
  frame: DirectoryScanFrame,
  entries: ScannedDirectoryEntry[],
  totals: DirectoryScanTotals,
  limits: DirectorySizeLimits,
): void {
  for (const entry of entries) {
    if (++totals.visited > limits.entries) {
      throw directorySizeLimitExceeded();
    }
    const role = scanRole(entry);
    if (role === "file") {
      totals.files++;
      totals.bytes += fileSizeBytes(entry);
    } else if (role === "directory") {
      frame.pending.push(entry.name);
    } else if (role === "opaque-directory") {
      // Cloud folders and similar directories hold data this scan cannot enter safely.
      throw new BunawayError({
        code: "UNSUPPORTED",
        message:
          "Storage directory contains a reparse point directory that cannot be totalled.",
      });
    }
  }
}
export class WindowsStorage
  extends StorageFiles
  implements WindowsStorageInstance
{
  private readonly api = createBindings();
  private fileApi: ReturnType<typeof createFileBindings> | null = null;
  /** Directory size scans still running; they need live bindings to close their handles. */
  private activeScans = 0;
  private releaseRequested = false;
  /**
   * Release this instance's bindings; other storage adapters retain their resources.
   * While a directory size scan is running, the release waits until the scan has closed its
   * handles. The returned promise settles once the bindings are closed, so callers that need
   * every handle gone (such as a test removing its tree) await it.
   */
  override dispose(): Promise<void> {
    try {
      super.dispose();
    } catch (error) {
      return Promise.reject(error);
    }
    if (!this.activeScans) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) =>
      this.drainWaiters.push({
        resolve,
        reject,
      }),
    );
  }
  protected release(): void {
    this.releaseRequested = true;
    if (!this.activeScans) {
      this.closeBindings();
    }
  }
  /** Callers of dispose waiting for running scans to finish closing their handles. */
  private readonly drainWaiters: {
    resolve: () => void;
    reject: (error: unknown) => void;
  }[] = [];
  /** Each binding is marked closed only after its close succeeded, so a failed release can be retried. */
  private apiClosed = false;
  private closeBindings(): void {
    if (this.fileApi) {
      this.fileApi.close();
      this.fileApi = null;
    }
    if (!this.apiClosed) {
      this.api.close();
      this.apiClosed = true;
    }
  }
  /**
   * Account for one finished scan. The last scan after disposal releases the bindings; a release
   * failure goes to the dispose callers and never replaces the scan's own result.
   */
  private finishScan(): void {
    this.activeScans--;
    if (!this.releaseRequested || this.activeScans) {
      return;
    }
    const waiters = this.drainWaiters.splice(0);
    try {
      this.closeBindings();
    } catch (error) {
      for (const waiter of waiters) {
        waiter.reject(error);
      }
      return;
    }
    for (const waiter of waiters) {
      waiter.resolve();
    }
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
  private close(handle: bigint) {
    this.check(this.api.symbols.CloseHandle(handle), "CloseHandle failed");
  }
  /** Attempt every close even after a failure, then report all failures together. */
  private closeAll(handles: bigint[]): void {
    attemptAll(
      handles.map((handle) => () => this.close(handle)),
      "Storage handle cleanup failed.",
    );
  }
  /** Preserve synchronous CreateFileW access/sharing semantics while capturing failure as NTSTATUS. */
  private open(
    path: string,
    access: number,
    share: number,
    disposition: FileDisposition,
    flags: number,
    allowMissing = false,
    /** Treat a target whose deletion is pending like a missing one when allowMissing is set. */
    skipDeletePending = false,
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
      // STATUS_DELETE_PENDING would otherwise surface as ERROR_ACCESS_DENIED.
      if (
        allowMissing &&
        skipDeletePending &&
        status >>> 0 === STATUS_DELETE_PENDING
      ) {
        return 0n;
      }
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
  /** Callers that check many handles may pass one reusable buffer; the result is a copy. */
  private canonical(
    handle: bigint,
    text: Buffer = Buffer.alloc(FINAL_PATH_BUFFER_CHARS * WCHAR_BYTES),
  ) {
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

  /**
   * Total the logical file sizes below one checked directory. Symlinks, junctions and reparse
   * point directories are neither followed nor counted, hardlinked files count once per name, and
   * sizes come from the directory listing, so concurrent changes are not a snapshot. Any access or
   * open failure below the root fails the whole operation instead of under-reporting.
   * The scan yields to the event loop periodically so cancellation and deadlines take effect while
   * it runs; every handle is closed on success, failure and cancellation.
   */
  directorySize(
    input: StorageLocation,
    signal?: AbortSignal,
  ): Promise<StorageDirectorySize> {
    return this.directorySizeWithin(input, signal, DIRECTORY_SIZE_LIMITS);
  }

  /**
   * The scan behind directorySize with explicit cost bounds. It is public only so tests can lower
   * the bounds; the operation map exposes directorySize, which always uses the contract limits,
   * so applications cannot choose their own bounds.
   */
  async directorySizeWithin(
    input: StorageLocation,
    signal: AbortSignal | undefined,
    limits: DirectorySizeLimits,
  ): Promise<StorageDirectorySize> {
    this.requireOpen();
    this.activeScans++;
    try {
      const result = this.withFile(
        input.path,
        {
          ...METADATA_TARGET_OPTIONS,
          allowMissing: false,
          // The walk can be long, so other processes may still rename or move within the parents.
          parentShare: FILE_SHARE_READ | FILE_SHARE_WRITE,
        },
        ({ handle, info, canonical }) => {
          this.requireDirectory(info);
          return this.sumDirectory(handle, canonical, signal, limits);
        },
      );
      // allowMissing is false, so a missing root throws; null cannot occur here.
      if (result === null) {
        throw new Error("Storage directory was not opened.");
      }
      return await result;
    } finally {
      this.finishScan();
    }
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
        this.deleteHandle(handle);
        return null;
      },
    );
    return null;
  }

  /**
   * Delete a checked file, or a directory with everything below it. Symlinks, junctions and other
   * name surrogates inside the tree are removed themselves and never followed, and hardlinked files
   * lose only the listed name. Read-only entries are removed like Node and Rust do. The walk keeps
   * every directory on the current path open, so no ancestor can be renamed or replaced while its
   * children are deleted. It yields to the event loop periodically so cancellation and deadlines
   * take effect; entries deleted before a failure or cancellation stay deleted.
   */
  async removeRecursive(
    input: StorageLocation,
    signal?: AbortSignal,
  ): Promise<null> {
    this.requireOpen();
    this.activeScans++;
    try {
      const result = this.withFile(
        input.path,
        {
          ...METADATA_TARGET_OPTIONS,
          access:
            DELETE |
            FILE_WRITE_ATTRIBUTES |
            FILE_READ_ATTRIBUTES |
            FILE_LIST_DIRECTORY,
          allowMissing: false,
          // The walk can be long, so other processes may still rename or move within the parents.
          parentShare: FILE_SHARE_READ | FILE_SHARE_WRITE,
        },
        ({ handle, info, canonical }) => {
          if (!(info.readUInt32LE(0) & FILE_ATTRIBUTE_DIRECTORY)) {
            if (signal?.aborted) {
              throw new BunawayError({
                code: "CANCELLED",
                message: "Storage directory removal was cancelled.",
              });
            }
            this.deleteForced(handle);
            return Promise.resolve(null);
          }
          return this.removeTree(handle, canonical, signal);
        },
      );
      // allowMissing is false, so a missing root throws; null cannot occur here.
      if (result === null) {
        throw new Error("Storage target was not opened.");
      }
      return await result;
    } finally {
      this.finishScan();
    }
  }

  /** Mark the checked object for deletion; the object disappears when its last handle closes. */
  private deleteHandle(handle: bigint): void {
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
  }

  /**
   * Delete the checked object even when it is read-only. POSIX semantics remove the name at once
   * instead of when the last handle closes, so scanners holding files open cannot make the parent
   * look non-empty, and the read-only attribute is ignored rather than cleared, which would also
   * change the other names of a hardlinked file. Filesystems without that support fall back to
   * clearing the attribute through the handle.
   */
  private deleteForced(handle: bigint): void {
    const flags = new Uint32Array([
      FILE_DISPOSITION_FORCE_FLAGS,
    ]);
    if (
      this.api.symbols.SetFileInformationByHandle(
        handle,
        FILE_DISPOSITION_INFO_EX,
        ptr(flags),
        flags.byteLength,
      )
    ) {
      return;
    }
    const error = this.api.symbols.GetLastError();
    if (error === ERROR_DIR_NOT_EMPTY) {
      throw new BunawayError({
        code: "INVALID_ARGUMENT",
        message: "Storage directory is not empty.",
      });
    }
    if (
      error !== ERROR_INVALID_PARAMETER &&
      error !== ERROR_NOT_SUPPORTED &&
      error !== ERROR_INVALID_FUNCTION
    ) {
      this.fail("Storage removal failed", error);
    }
    this.deleteLegacy(handle);
  }

  /** Clear the read-only attribute through the checked handle, then mark the object for deletion. */
  private deleteLegacy(handle: bigint): void {
    const attributes = this.info(handle).readUInt32LE(0);
    if (attributes & FILE_ATTRIBUTE_READONLY) {
      const basic = Buffer.alloc(FILE_BASIC_INFO_BYTES);
      // Zero timestamps keep their values; a zero attribute set would also keep READONLY.
      basic.writeUInt32LE(
        attributes & ~FILE_ATTRIBUTE_READONLY || FILE_ATTRIBUTE_NORMAL,
        FILE_BASIC_ATTRIBUTES_OFFSET,
      );
      this.check(
        this.api.symbols.SetFileInformationByHandle(
          handle,
          FILE_BASIC_INFO,
          ptr(basic),
          basic.byteLength,
        ),
        "Storage attribute update failed",
      );
    }
    this.deleteHandle(handle);
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
  protected readFile(path: string, maxBytes: number): Buffer {
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
  protected writeFile(path: string, bytes: Buffer, append: boolean): null {
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
  /**
   * Pin and inspect every parent, including the volume, until the owned action finishes.
   * Parents are opened with parentShare, read sharing only by default; delete sharing is never granted.
   */
  private withParent<T>(
    path: string,
    createParents: boolean,
    allowMissing: boolean,
    action: (parent: { target: string }) => T,
    parentShare = FILE_SHARE_READ,
  ): T | null {
    this.requireOpen();
    const { volume, segments } = selectedPath(path);
    const parents: bigint[] = [];
    return withRelease(
      () => {
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
            parentShare,
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
      },
      () =>
        this.closeAll(
          [
            ...parents,
          ].reverse(),
        ),
    );
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
        return withRelease(
          () => {
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
          },
          () => this.close(handle),
        );
      },
      options.parentShare,
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
    let restart = true;
    while (this.readEntryBatch(handle, buffer, restart)) {
      restart = false;
      const batch = directoryEntries(buffer);
      if (entries.length + batch.length > MAX_DIRECTORY_ENTRIES) {
        throw new BunawayError({
          code: "INVALID_ARGUMENT",
          message: "Storage directory exceeds the entry limit.",
        });
      }
      entries.push(...batch);
    }
    return entries.sort((left, right) =>
      left.name < right.name ? -1 : Number(left.name > right.name),
    );
  }
  /** Fill the buffer with the next native entry batch; false once the directory is exhausted. */
  private readEntryBatch(
    handle: bigint,
    buffer: Buffer,
    restart: boolean,
  ): boolean {
    buffer.fill(0);
    if (
      this.api.symbols.GetFileInformationByHandleEx(
        handle,
        restart
          ? FILE_ID_BOTH_DIRECTORY_RESTART_INFO
          : FILE_ID_BOTH_DIRECTORY_INFO,
        ptr(buffer),
        buffer.length,
      )
    ) {
      return true;
    }
    const error = this.api.symbols.GetLastError();
    if (error === ERROR_NO_MORE_FILES) {
      return false;
    }
    this.fail("Storage directory listing failed", error);
  }
  /**
   * Open one listed child directory beneath its pinned parent without following links.
   * Returns null when the child vanished or is no longer a plain directory, so it adds nothing.
   */
  private openChildDirectory(
    parentPath: string,
    name: string,
    pathBuffer: Buffer,
    access = FILE_READ_ATTRIBUTES | FILE_LIST_DIRECTORY,
  ) {
    const path = `${parentPath}\\${name}`;
    // Same sharing as the root target; delete sharing stays excluded so the path remains pinned.
    const handle = this.open(
      path,
      access,
      FILE_SHARE_READ | FILE_SHARE_WRITE,
      OPEN_EXISTING,
      DIRECTORY_OPEN_FLAGS,
      true,
      true,
    );
    if (!handle) {
      return null;
    }
    let plainDirectory: boolean;
    try {
      const attributes = this.info(handle).readUInt32LE(0);
      plainDirectory =
        !(attributes & FILE_ATTRIBUTE_REPARSE_POINT) &&
        Boolean(attributes & FILE_ATTRIBUTE_DIRECTORY);
      if (plainDirectory && this.canonical(handle, pathBuffer) !== path) {
        deny("Storage path must use its canonical spelling.");
      }
    } catch (error) {
      // A kept handle is released by the scan; a failed check releases it here.
      return failWithCleanup(
        error,
        () => this.close(handle),
        STORAGE_CLEANUP_MESSAGE,
      );
    }
    if (!plainDirectory) {
      this.close(handle);
      return null;
    }
    return {
      handle,
      path,
    };
  }
  /** One walk step: open a queued child, read an entry batch, or finish the top directory. */
  private scanStep(
    path: DirectoryScanFrame[],
    buffers: {
      entries: Buffer;
      path: Buffer;
    },
    totals: DirectoryScanTotals,
    limits: DirectorySizeLimits,
  ): void {
    const frame = path[path.length - 1] as DirectoryScanFrame;
    const childName = frame.pending.pop();
    if (childName !== undefined) {
      if (path.length > limits.depth) {
        throw directorySizeLimitExceeded();
      }
      const child = this.openChildDirectory(
        frame.path,
        childName,
        buffers.path,
      );
      if (child) {
        totals.directories++;
        path.push({
          ...child,
          restart: true,
          pending: [],
        });
      }
    } else if (
      this.readEntryBatch(frame.handle, buffers.entries, frame.restart)
    ) {
      frame.restart = false;
      tallyEntries(
        frame,
        scanDirectoryEntries(buffers.entries),
        totals,
        limits,
      );
    } else {
      // Pop before closing so a failed close cannot be retried by the caller's cleanup.
      path.pop();
      if (path.length) {
        this.close(frame.handle);
      }
    }
  }
  /**
   * Walk until the root is finished. Yielding every few steps lets the I/O Worker process cancel
   * and deadline messages, which are observed through the signal at the next step.
   */
  private async walkDirectories(
    path: DirectoryScanFrame[],
    signal: AbortSignal | undefined,
    limits: DirectorySizeLimits,
  ): Promise<DirectoryScanTotals> {
    const totals: DirectoryScanTotals = {
      bytes: 0n,
      files: 0,
      directories: 0,
      visited: 0,
    };
    await this.walkSteps(
      path,
      signal,
      "Storage directory size scan was cancelled.",
      (buffers) => this.scanStep(path, buffers, totals, limits),
    );
    return totals;
  }
  /** Run walk steps until the path is empty, yielding to the event loop and honoring the signal. */
  private async walkSteps(
    path: DirectoryScanFrame[],
    signal: AbortSignal | undefined,
    cancelMessage: string,
    step: (buffers: { entries: Buffer; path: Buffer }) => void,
  ): Promise<void> {
    const buffers = {
      entries: Buffer.alloc(DIRECTORY_BUFFER_BYTES),
      path: Buffer.alloc(FINAL_PATH_BUFFER_CHARS * WCHAR_BYTES),
    };
    for (let steps = 1; path.length; steps++) {
      if (steps % DIRECTORY_SIZE_YIELD_STEPS === 0) {
        await yieldToEventLoop();
        // Disposal during the yield stops the walk; the bindings stay open until it cleans up.
        this.requireOpen();
      }
      if (signal?.aborted) {
        throw new BunawayError({
          code: "CANCELLED",
          message: cancelMessage,
        });
      }
      step(buffers);
    }
  }
  /** Delete the checked root directory's contents depth first, then the directories themselves. */
  private async removeTree(
    rootHandle: bigint,
    rootPath: string,
    signal: AbortSignal | undefined,
  ): Promise<null> {
    const path: DirectoryScanFrame[] = [
      {
        handle: rootHandle,
        path: rootPath,
        restart: true,
        pending: [],
      },
    ];
    await withRelease(
      () =>
        this.walkSteps(
          path,
          signal,
          "Storage directory removal was cancelled.",
          (buffers) => this.removeStep(path, buffers),
        ),
      // Failure and cancellation leave child directories open; the caller releases the root.
      () =>
        this.closeAll(
          path
            .slice(1)
            .reverse()
            .map((frame) => frame.handle),
        ),
    );
    return null;
  }
  /** One removal step: descend into a queued child, delete a batch of entries, or delete the top directory. */
  private removeStep(
    path: DirectoryScanFrame[],
    buffers: {
      entries: Buffer;
      path: Buffer;
    },
  ): void {
    const frame = path[path.length - 1] as DirectoryScanFrame;
    const childName = frame.pending.pop();
    if (childName !== undefined) {
      if (path.length > MAX_DIRECTORY_SIZE_DEPTH) {
        throw new BunawayError({
          code: "INVALID_ARGUMENT",
          message: "Storage directory exceeds the removal depth limit.",
        });
      }
      const child = this.openChildDirectory(
        frame.path,
        childName,
        buffers.path,
        DELETE |
          FILE_WRITE_ATTRIBUTES |
          FILE_READ_ATTRIBUTES |
          FILE_LIST_DIRECTORY,
      );
      if (child) {
        path.push({
          ...child,
          restart: true,
          pending: [],
        });
      }
    } else if (
      this.readEntryBatch(frame.handle, buffers.entries, frame.restart)
    ) {
      frame.restart = false;
      for (const entry of scanDirectoryEntries(buffers.entries)) {
        const role = scanRole(entry);
        if (role === "directory") {
          frame.pending.push(entry.name);
        } else if (role === "opaque-directory") {
          // Cloud folders and similar directories hold data this walk cannot enter safely.
          throw new BunawayError({
            code: "UNSUPPORTED",
            message:
              "Storage directory contains a reparse point directory that cannot be removed.",
          });
        } else {
          this.removeLeaf(frame.path, entry, buffers.path);
        }
      }
    } else {
      // Everything below is gone, so the empty directory can go. Pop before closing so a failed
      // close cannot be retried by the caller's cleanup.
      this.deleteForced(frame.handle);
      path.pop();
      if (path.length) {
        this.close(frame.handle);
      }
    }
  }
  /**
   * Delete one listed non-directory child, or a name surrogate link, itself: the open does not
   * follow reparse points. A child that vanished is skipped; one that became a real directory since
   * the listing is refused rather than deleted without its contents being walked.
   */
  private removeLeaf(
    parentPath: string,
    entry: ScannedDirectoryEntry,
    pathBuffer: Buffer,
  ): void {
    const path = `${parentPath}\\${entry.name}`;
    const handle = this.open(
      path,
      DELETE | FILE_WRITE_ATTRIBUTES | FILE_READ_ATTRIBUTES,
      FILE_SHARE_ALL,
      OPEN_EXISTING,
      entry.isDirectoryAttribute
        ? DIRECTORY_OPEN_FLAGS
        : FILE_FLAG_OPEN_REPARSE_POINT,
      true,
      true,
    );
    if (!handle) {
      return;
    }
    withRelease(
      () => {
        const attributes = this.info(handle).readUInt32LE(0);
        if (
          attributes & FILE_ATTRIBUTE_DIRECTORY &&
          !(attributes & FILE_ATTRIBUTE_REPARSE_POINT)
        ) {
          deny("Storage tree changed during removal.");
        }
        // A reparse point swapped into an ancestor after the listing would redirect the open by
        // name; the handle must still be the listed child of the pinned parent.
        if (this.canonical(handle, pathBuffer) !== path) {
          deny("Storage tree changed during removal.");
        }
        this.deleteForced(handle);
      },
      () => this.close(handle),
    );
  }
  /** Recursively total the checked root without following links; the caller owns the root handle. */
  private async sumDirectory(
    rootHandle: bigint,
    rootPath: string,
    signal: AbortSignal | undefined,
    limits: DirectorySizeLimits,
  ): Promise<StorageDirectorySize> {
    // Iterative depth-first walk. Every directory on the current path stays open,
    // so no ancestor can be renamed or deleted while its descendants are read.
    const path: DirectoryScanFrame[] = [
      {
        handle: rootHandle,
        path: rootPath,
        restart: true,
        pending: [],
      },
    ];
    const totals = await withRelease(
      () => this.walkDirectories(path, signal, limits),
      // Failure and cancellation leave child directories open; the caller releases the root.
      () =>
        this.closeAll(
          path
            .slice(1)
            .reverse()
            .map((frame) => frame.handle),
        ),
    );
    if (totals.bytes > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("Storage size cannot be represented safely.");
    }
    return {
      bytes: Number(totals.bytes),
      files: totals.files,
      directories: totals.directories,
    };
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
