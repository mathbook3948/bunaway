import { dlopen, ptr, read } from "bun:ffi";
import {
  type BigIntStats,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  readSync,
  writeSync,
} from "node:fs";
import {
  BunawayError,
  type JsonValue,
  type NativeAdapter,
} from "@bunaway/plugin";
import { MAX_STORAGE_BYTES } from "../bytes.ts";
import type {
  StorageBytesWrite,
  StorageLocation,
  StorageMetadata,
  StorageTransfer,
  StorageWrite,
} from "../contract.ts";

const LIB_SYSTEM = "/usr/lib/libSystem.B.dylib";
const MAX_PATH_BYTES = 1024;
const MAX_NAME_BYTES = 255;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_IO_CHUNK_BYTES = 1 << 20;
const F_GETPATH = 50;
const O_CLOEXEC = 0x1000000;
const AT_FDCWD = -2;
const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const ENOENT = 2;
const ENXIO = 6;
const EPERM = 1;
const EACCES = 13;
const EEXIST = 17;
const ENOTDIR = 20;
const EISDIR = 21;
const ELOOP = 62;
const ENOTSUP = 45;
const EXDEV = 18;

type StorageInput =
  | StorageLocation
  | StorageWrite
  | StorageBytesWrite
  | StorageTransfer;
type Parent = {
  fd: number;
  name: string;
  path: string;
};
type Target = {
  fd: number;
  info: BigIntStats;
};

/** Construct only on the host's I/O worker; imports allocate no OS resources. */
export function createOperations(): NativeAdapter {
  const storage = new MacosStorage();
  return {
    execute(operation, input) {
      // The host registry validates the public schema before this boundary.
      return storage.execute(operation, input as StorageInput);
    },
    dispose: () => storage.dispose(),
  };
}

function createBindings() {
  return dlopen(LIB_SYSTEM, {
    // Darwin arm64 puts variadic arguments on the stack. These fixed-arity
    // syscall entrypoints avoid miscalling openat(mode) and fcntl(pointer).
    // See Apple's libsyscall/wrappers/open-base.c and cancelable/fcntl-base.c.
    __openat: {
      args: [
        "i32",
        "ptr",
        "i32",
        "u32",
      ],
      returns: "i32",
    },
    __fcntl: {
      args: [
        "i32",
        "i32",
        "ptr",
      ],
      returns: "i32",
    },
    __error: {
      args: [],
      returns: "ptr",
    },
    mkdirat: {
      args: [
        "i32",
        "ptr",
        "u32",
      ],
      returns: "i32",
    },
  });
}

function fail(
  code: "INVALID_ARGUMENT" | "PERMISSION_DENIED",
  message: string,
): never {
  throw new BunawayError({
    code,
    message,
  });
}

/** Reject aliases before traversal, including UTF-16 that cannot round-trip through POSIX UTF-8. */
function selectedPath(path: string): string[] {
  const segments = path.slice(1).split("/");
  if (
    !path.startsWith("/") ||
    Buffer.byteLength(path) >= MAX_PATH_BYTES ||
    Buffer.from(path).toString() !== path ||
    /[\0\r\n]/u.test(path) ||
    segments.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        Buffer.byteLength(part) > MAX_NAME_BYTES,
    )
  ) {
    fail("INVALID_ARGUMENT", "Invalid storage path.");
  }
  return segments;
}

function safeSize(info: BigIntStats, limit: number): number {
  if (info.size < 0n || info.size > BigInt(limit)) {
    fail("INVALID_ARGUMENT", "Storage file exceeds the bounded I/O limit.");
  }
  return Number(info.size);
}

function timeMs(nanoseconds: bigint): number | null {
  const value = Number(nanoseconds / 1_000_000n);
  return Number.isSafeInteger(value) ? value : null;
}

function metadata(info: BigIntStats): StorageMetadata {
  const times = {
    createdAtMs: timeMs(info.birthtimeNs),
    modifiedAtMs: timeMs(info.mtimeNs),
    accessedAtMs: timeMs(info.atimeNs),
  };
  if (info.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Storage size cannot be represented safely.");
  }
  return info.isDirectory()
    ? {
        kind: "directory",
        sizeBytes: null,
        ...times,
      }
    : {
        kind: "file",
        sizeBytes: safeSize(info, Number.MAX_SAFE_INTEGER),
        ...times,
      };
}

/**
 * Own native bindings per adapter and descriptors per call. Every path component
 * is opened relative to its checked directory, with no symlink following.
 * POSIX keeps open objects alive but does not exclude other processes' renames
 * or writes. No cleanup unlinks a target by a potentially replaced name.
 */
export class MacosStorage {
  private readonly api: ReturnType<typeof createBindings>;
  private disposed = false;

  constructor() {
    if (process.platform !== "darwin") {
      throw new BunawayError({
        code: "UNSUPPORTED",
        message: "macOS storage requires Darwin.",
      });
    }
    this.api = createBindings();
  }

  /** Release only this adapter's bindings; safe to repeat after success or failure. */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.api.close();
  }

  private errno(): number {
    const address = this.api.symbols.__error();
    if (!address) {
      throw new Error("Storage errno is unavailable.");
    }
    return read.i32(address);
  }

  private nativeFailure(message: string, code = this.errno()): never {
    if (code === ENOENT) {
      fail("INVALID_ARGUMENT", "Storage target not found.");
    }
    if (code === EEXIST) {
      fail("INVALID_ARGUMENT", "Storage destination already exists.");
    }
    if (
      code === EACCES ||
      code === EPERM ||
      code === ELOOP ||
      code === ENOTDIR ||
      code === EISDIR ||
      code === ENXIO
    ) {
      fail("PERMISSION_DENIED", "Storage access or path denied.");
    }
    if (code === EXDEV || code === ENOTSUP) {
      throw new BunawayError({
        code: "UNSUPPORTED",
        message: "Storage filesystem operation is unsupported.",
      });
    }
    throw new Error(`${message} (${code})`);
  }

  private fileAction<T>(action: () => T): T {
    try {
      return action();
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error.code === "EACCES" || error.code === "EPERM")
      ) {
        const denied = new BunawayError({
          code: "PERMISSION_DENIED",
          message: "Storage access denied.",
        });
        denied.cause = error;
        throw denied;
      }
      throw error;
    }
  }

  private open(
    parent: number,
    name: string,
    flags: number,
    allowMissing: boolean,
  ): number | null {
    const fd = this.api.symbols.__openat(
      parent,
      ptr(Buffer.from(`${name}\0`)),
      flags | constants.O_NOFOLLOW | O_CLOEXEC | constants.O_NONBLOCK,
      FILE_MODE,
    );
    if (fd >= 0) {
      return fd;
    }
    const code = this.errno();
    if (allowMissing && code === ENOENT) {
      return null;
    }
    this.nativeFailure("Storage open failed", code);
  }

  private canonical(fd: number, expected: string): void {
    const buffer = Buffer.alloc(MAX_PATH_BYTES);
    if (this.api.symbols.__fcntl(fd, F_GETPATH, ptr(buffer)) < 0) {
      this.nativeFailure("Storage path check failed");
    }
    const end = buffer.indexOf(0);
    if (
      end < 0 ||
      buffer.subarray(0, end).toString().normalize("NFC") !==
        expected.normalize("NFC")
    ) {
      fail(
        "PERMISSION_DENIED",
        "Storage path must use its canonical spelling.",
      );
    }
  }

  /** Keep each parent alive through the action; only ENOENT means an absent path. */
  private withParent<T>(
    path: string,
    create: boolean,
    allowMissing: boolean,
    action: (parent: Parent) => T,
  ): T | null {
    const segments = selectedPath(path);
    const name = segments.pop();
    if (!name) {
      fail("INVALID_ARGUMENT", "Invalid storage path.");
    }
    const parents: number[] = [];
    try {
      let parent = this.open(
        AT_FDCWD,
        "/",
        constants.O_RDONLY | constants.O_DIRECTORY,
        false,
      );
      if (parent === null) {
        throw new Error("Storage root is unavailable.");
      }
      parents.push(parent);
      let current = "";
      for (const segment of segments) {
        if (
          create &&
          this.api.symbols.mkdirat(
            parent,
            ptr(Buffer.from(`${segment}\0`)),
            DIRECTORY_MODE,
          ) < 0
        ) {
          const code = this.errno();
          if (code !== EEXIST) {
            this.nativeFailure("Storage parent creation failed", code);
          }
        }
        const fd = this.open(
          parent,
          segment,
          constants.O_RDONLY | constants.O_DIRECTORY,
          allowMissing,
        );
        if (fd === null) {
          return null;
        }
        parents.push(fd);
        current += `/${segment}`;
        this.canonical(fd, current);
        parent = fd;
      }
      return action({
        fd: parent,
        name,
        path: current || "/",
      });
    } finally {
      this.closeParents(parents);
    }
  }

  /** Close all pins once, even if one close fails; an EINTR close must not be retried. */
  private closeParents(parents: number[]): void {
    const failures: unknown[] = [];
    for (const fd of parents.reverse()) {
      try {
        closeSync(fd);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) {
      throw new AggregateError(failures, "Storage parent cleanup failed.");
    }
  }

  private withTarget<T>(
    parent: Parent,
    flags: number,
    allowMissing: boolean,
    allowDirectory: boolean,
    action: (target: Target) => T,
  ): T | null {
    const fd = this.open(parent.fd, parent.name, flags, allowMissing);
    if (fd === null) {
      return null;
    }
    try {
      const info = this.fileAction(() =>
        fstatSync(fd, {
          bigint: true,
        }),
      );
      if (
        (!info.isFile() && !(allowDirectory && info.isDirectory())) ||
        (info.isFile() && info.nlink !== 1n)
      ) {
        fail(
          "PERMISSION_DENIED",
          "Storage target is not a plain file or directory.",
        );
      }
      this.canonical(
        fd,
        `${parent.path === "/" ? "" : parent.path}/${parent.name}`,
      );
      return action({
        fd,
        info,
      });
    } finally {
      closeSync(fd);
    }
  }

  /** Dispatch schema-validated operations without introducing new directory contracts. */
  execute(operation: string, input: StorageInput): JsonValue {
    if (this.disposed) {
      throw new BunawayError({
        code: "CANCELLED",
        message: "Storage adapter is disposed.",
      });
    }
    if ("from" in input) {
      selectedPath(input.from);
      selectedPath(input.to);
      if (operation === "storage.copyFile") {
        return this.copyFile(input);
      }
      throw new BunawayError({
        code: "UNSUPPORTED",
        message: "Unknown storage operation.",
      });
    }
    const querying =
      operation === "storage.exists" || operation === "storage.stat";
    const appending =
      operation === "storage.appendText" || operation === "storage.appendBytes";
    const writingText =
      operation === "storage.writeText" || operation === "storage.appendText";
    const writingBytes =
      operation === "storage.writeBytes" || operation === "storage.appendBytes";
    const writing = writingText || writingBytes;
    const readingBytes = operation === "storage.readBytes";
    if (
      !querying &&
      !writing &&
      !readingBytes &&
      operation !== "storage.readText"
    ) {
      throw new BunawayError({
        code: "UNSUPPORTED",
        message: "Unknown storage operation.",
      });
    }
    let bytes: Buffer | undefined;
    if (writingText) {
      if (!("text" in input)) {
        fail("INVALID_ARGUMENT", "Storage text is required.");
      }
      bytes = Buffer.from(input.text);
    } else if (writingBytes) {
      if (!("bytes" in input)) {
        fail("INVALID_ARGUMENT", "Storage bytes are required.");
      }
      bytes = Buffer.from(input.bytes, "base64");
    }
    // Never use O_TRUNC: validate the opened object before changing any bytes.
    const flags = writing
      ? constants.O_WRONLY |
        constants.O_CREAT |
        (appending ? constants.O_APPEND : 0)
      : constants.O_RDONLY;
    const result = this.withParent(input.path, writing, querying, (parent) =>
      this.withTarget(parent, flags, querying, querying, ({ fd, info }) => {
        if (querying) {
          return operation === "storage.exists" ? true : metadata(info);
        }
        if (bytes !== undefined) {
          this.writeBytes(fd, bytes);
          if (!appending) {
            this.fileAction(() => ftruncateSync(fd, bytes.length));
          }
          this.fileAction(() => fsyncSync(fd));
          return null;
        }
        const limit = readingBytes ? MAX_STORAGE_BYTES : MAX_FILE_BYTES;
        if (info.size < 0n || info.size > BigInt(limit)) {
          throw new Error("Storage file too large.");
        }
        const contents = this.readBytes(fd, Number(info.size));
        return readingBytes
          ? contents.toString("base64")
          : new TextDecoder("utf-8", {
              fatal: true,
              ignoreBOM: true,
            }).decode(contents);
      }),
    );
    return result === null && operation === "storage.exists" ? false : result;
  }

  private readBytes(fd: number, size: number): Buffer {
    const bytes = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const count = this.fileAction(() =>
        readSync(
          fd,
          bytes,
          offset,
          Math.min(size - offset, MAX_IO_CHUNK_BYTES),
          null,
        ),
      );
      if (!count) {
        throw new Error("Storage file changed during read.");
      }
      offset += count;
    }
    return bytes;
  }

  private writeBytes(fd: number, bytes: Buffer): void {
    let offset = 0;
    while (offset < bytes.length) {
      const count = this.fileAction(() =>
        writeSync(
          fd,
          bytes,
          offset,
          Math.min(bytes.length - offset, MAX_IO_CHUNK_BYTES),
          null,
        ),
      );
      if (!count) {
        throw new Error("Storage write made no progress.");
      }
      offset += count;
    }
  }

  /** Read the bounded source before creating a destination; O_EXCL never replaces a raced name. */
  private copyFile(input: StorageTransfer): null {
    this.withParent(input.from, false, false, (parent) =>
      this.withTarget(
        parent,
        constants.O_RDONLY,
        false,
        false,
        ({ fd, info }) => {
          const bytes = this.readBytes(fd, safeSize(info, MAX_FILE_BYTES));
          this.withParent(input.to, false, false, (destination) =>
            this.withTarget(
              destination,
              constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
              false,
              false,
              (target) => {
                this.writeBytes(target.fd, bytes);
                this.fileAction(() => fsyncSync(target.fd));
                // A failed copy may leave a partial file. Unlinking by name could
                // delete a replacement; POSIX has no unlink-by-open-handle API.
                return null;
              },
            ),
          );
          return null;
        },
      ),
    );
    return null;
  }
}
