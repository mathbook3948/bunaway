import {
  type BigIntStats,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { dirname } from "node:path";
import { BunawayError, failWithCleanup } from "@bunaway/plugin";
import {
  MAX_DIRECTORY_SIZE_DEPTH,
  MAX_DIRECTORY_SIZE_ENTRIES,
  type StorageDirectoryCreate,
  type StorageDirectoryEntry,
  type StorageDirectorySize,
  type StorageInstance,
  type StorageLocation,
  type StorageMetadata,
  type StorageTransfer,
} from "#storage/contract";
import { StorageFiles } from "#storage/platforms/files";
import {
  type DirectorySizeLimits,
  listDirectory,
  sumDirectory,
} from "#storage/platforms/node-directory";

const MAX_IO_CHUNK_BYTES = 1 << 20;
const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
/** Opening a FIFO or device without O_NONBLOCK can wait forever; the type check follows the open. */
const NONBLOCK = constants.O_NONBLOCK ?? 0;
const DESCRIPTOR_CLEANUP_MESSAGE =
  "Storage operation failed and cleanup failed.";

/** Cost bounds of one directorySize call; only tests pass values other than the contract defaults. */
export const DIRECTORY_SIZE_LIMITS: DirectorySizeLimits = {
  entries: MAX_DIRECTORY_SIZE_ENTRIES,
  depth: MAX_DIRECTORY_SIZE_DEPTH,
};

/** The path syntax a platform accepts; it never touches the file system. */
export type PathRules = {
  /** Validate the spelling of an app-selected path and return the form used for file system calls. */
  normalize(path: string): string;
  /** Whether `child` lies below `parent` under the platform's name comparison. */
  isBelow(parent: string, child: string): boolean;
};

function errorCode(error: unknown): unknown {
  return error instanceof Error ? Reflect.get(error, "code") : undefined;
}

/** A path that does not exist, or runs through something that is not a directory. */
export function isMissing(error: unknown): boolean {
  const code = errorCode(error);
  return code === "ENOENT" || code === "ENOTDIR";
}

export function failure(
  code: ConstructorParameters<typeof BunawayError>[0]["code"],
  message: string,
): BunawayError {
  return new BunawayError({
    code,
    message,
  });
}

/** The public error for an operating system error code, or undefined when it has none. */
function mappedFailure(code: unknown): BunawayError | undefined {
  switch (code) {
    case "ENOENT":
    case "ENOTDIR":
      return failure("INVALID_ARGUMENT", "Storage target not found.");
    case "EEXIST":
      return failure("INVALID_ARGUMENT", "Storage destination already exists.");
    case "ENOTEMPTY":
      return failure("INVALID_ARGUMENT", "Storage directory is not empty.");
    case "EISDIR":
    case "ENXIO":
      return failure("INVALID_ARGUMENT", "Storage target is not a file.");
    case "ENAMETOOLONG":
      return failure("INVALID_ARGUMENT", "Storage path is too long.");
    case "EACCES":
    case "EPERM":
    case "ELOOP":
      return failure("PERMISSION_DENIED", "Storage access denied.");
    case "EXDEV":
    case "ENOTSUP":
      return failure(
        "UNSUPPORTED",
        "Storage filesystem operation is unsupported.",
      );
    default:
      return undefined;
  }
}

/** Translate a file system error into the public contract; unmapped errors pass through unchanged. */
export function storageError(error: unknown): unknown {
  if (error instanceof BunawayError) {
    return error;
  }
  const mapped = mappedFailure(errorCode(error));
  if (!mapped) {
    return error;
  }
  mapped.cause = error;
  return mapped;
}

function fsCall<T>(action: () => T): T {
  try {
    return action();
  } catch (error) {
    throw storageError(error);
  }
}

function timeMs(nanoseconds: bigint): number | null {
  // A zero time means the file system does not record it.
  if (nanoseconds === 0n) {
    return null;
  }
  const value = Number(nanoseconds / 1_000_000n);
  return Number.isSafeInteger(value) ? value : null;
}

/** Convert the stat of a file or directory to the public metadata shape. */
function metadata(info: BigIntStats): StorageMetadata {
  const times = {
    createdAtMs: timeMs(info.birthtimeNs),
    modifiedAtMs: timeMs(info.mtimeNs),
    accessedAtMs: timeMs(info.atimeNs),
  };
  if (info.isDirectory()) {
    return {
      kind: "directory",
      sizeBytes: null,
      ...times,
    };
  }
  if (!info.isFile()) {
    throw failure("INVALID_ARGUMENT", "Storage target is not a file.");
  }
  if (info.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Storage size cannot be represented safely.");
  }
  return {
    kind: "file",
    sizeBytes: Number(info.size),
    ...times,
  };
}

/** Close a descriptor after the action; a close failure never hides the action's own error. */
function withDescriptor<T>(fd: number, action: () => T): T {
  let result: T;
  try {
    result = action();
  } catch (error) {
    return failWithCleanup(
      error,
      () => closeSync(fd),
      DESCRIPTOR_CLEANUP_MESSAGE,
    );
  }
  closeSync(fd);
  return result;
}

/** Read exactly `size` bytes from the current position. */
function readBytes(fd: number, size: number): Buffer {
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const count = readSync(
      fd,
      bytes,
      offset,
      Math.min(size - offset, MAX_IO_CHUNK_BYTES),
      null,
    );
    if (!count) {
      throw new Error("Storage file changed during read.");
    }
    offset += count;
  }
  return bytes;
}

/** Write all bytes, making progress across partial writes. */
function writeBytes(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    const count = writeSync(
      fd,
      bytes,
      offset,
      Math.min(bytes.length - offset, MAX_IO_CHUNK_BYTES),
      null,
    );
    if (!count) {
      throw new Error("Storage write made no progress.");
    }
    offset += count;
  }
}

/** Create the missing folders above a file that is about to be written. */
function ensureParentDirectory(path: string): void {
  const parent = dirname(path);
  try {
    if (statSync(parent).isDirectory()) {
      return;
    }
  } catch (error) {
    if (!isMissing(error)) {
      throw error;
    }
  }
  mkdirSync(parent, {
    recursive: true,
    mode: DIRECTORY_MODE,
  });
}

/**
 * The storage operations on top of `node:fs`, shared by every platform. A platform supplies the
 * path syntax, the no-replace rename and the release of its native bindings.
 *
 * Paths are followed through links like any other file API: this layer checks that a path is
 * well-formed and reports file system failures with the storage error contract, but which
 * locations an app may reach is the app's decision (ADR 0024). Nothing here pins a checked object
 * between operations, so another process can replace what a name points to. Recursive removal
 * and directory totals never follow links.
 */
export abstract class NodeStorage
  extends StorageFiles
  implements StorageInstance
{
  constructor(private readonly rules: PathRules) {
    super();
  }

  /** Rename `from` to `to` without replacing an existing `to`, reporting failures with the storage contract. */
  protected abstract moveWithoutReplace(from: string, to: string): void;

  /** Check the spelling of an app-selected path; refuses work after dispose. */
  private selected(path: string): string {
    this.requireOpen();
    return this.rules.normalize(path);
  }

  /**
   * Open a path, require a regular file, and run the action with the descriptor. Links are
   * followed; a directory, FIFO or device is refused.
   */
  private withFile<T>(
    path: string,
    flags: number,
    action: (fd: number, info: BigIntStats) => T,
  ): T {
    const fd = fsCall(() => openSync(path, flags | NONBLOCK, FILE_MODE));
    return withDescriptor(fd, () =>
      fsCall(() => {
        const info = fstatSync(fd, {
          bigint: true,
        });
        if (!info.isFile()) {
          throw failure("INVALID_ARGUMENT", "Storage target is not a file.");
        }
        return action(fd, info);
      }),
    );
  }

  /** Missing targets return false; invalid paths and access failures throw. */
  exists(input: StorageLocation): boolean {
    return this.stat(input) !== null;
  }

  /** Missing targets return null. */
  stat(input: StorageLocation): StorageMetadata | null {
    const path = this.selected(input.path);
    try {
      return metadata(
        statSync(path, {
          bigint: true,
        }),
      );
    } catch (error) {
      if (isMissing(error)) {
        return null;
      }
      throw storageError(error);
    }
  }

  readDirectory(input: StorageLocation): StorageDirectoryEntry[] {
    const path = this.selected(input.path);
    return fsCall(() => listDirectory(path));
  }

  /**
   * Total the logical file sizes below a directory. Links are neither followed nor counted,
   * hardlinked files count once per name, and sizes come from the listing, so concurrent changes
   * are not a snapshot. Any failure below the root fails the whole operation instead of
   * under-reporting. The scan yields to the event loop periodically so cancellation and
   * deadlines take effect while it runs.
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
    const path = this.selected(input.path);
    const root = fsCall(() => statSync(path));
    if (!root.isDirectory()) {
      throw failure("INVALID_ARGUMENT", "Storage target is not a directory.");
    }
    try {
      return await sumDirectory(path, limits, signal, () => this.requireOpen());
    } catch (error) {
      throw storageError(error);
    }
  }

  /** Creating a directory that already exists succeeds; a file in the way is an error. */
  createDirectory(input: StorageDirectoryCreate): null {
    const path = this.selected(input.path);
    try {
      mkdirSync(path, {
        recursive: input.recursive,
        mode: DIRECTORY_MODE,
      });
    } catch (error) {
      if (errorCode(error) !== "EEXIST" || !this.isDirectory(path)) {
        throw storageError(error);
      }
    }
    return null;
  }

  private isDirectory(path: string): boolean {
    try {
      return statSync(path).isDirectory();
    } catch {
      // The path vanished or became unreadable after the failed create, so it is not a usable directory.
      return false;
    }
  }

  /**
   * Remove one file, link or empty directory. A link is removed itself and its target is left
   * alone. A directory that still has entries is refused.
   */
  remove(input: StorageLocation): null {
    const path = this.selected(input.path);
    fsCall(() => {
      if (lstatSync(path).isDirectory()) {
        rmdirSync(path);
        return;
      }
      try {
        unlinkSync(path);
      } catch (error) {
        // Windows reports EPERM when unlink meets a link to a directory, which rmdir removes.
        if (errorCode(error) !== "EPERM" && errorCode(error) !== "EISDIR") {
          throw error;
        }
        try {
          rmdirSync(path);
        } catch {
          // The target is not a directory link, so the first error is the real one.
          throw error;
        }
      }
    });
    return null;
  }

  /**
   * Remove a file, or a directory with everything below it. Links inside the tree are removed
   * themselves and never followed, as far as `lstat` reports them (a volume mount point may be
   * reported as a directory and would be descended). The removal is one file system call that cannot be
   * interrupted, so cancellation only takes effect before it starts; entries deleted before a
   * failure stay deleted.
   */
  async removeRecursive(
    input: StorageLocation,
    signal?: AbortSignal,
  ): Promise<null> {
    const path = this.selected(input.path);
    if (signal?.aborted) {
      throw failure("CANCELLED", "Storage removal was cancelled.");
    }
    fsCall(() => lstatSync(path));
    try {
      await rm(path, {
        recursive: true,
      });
    } catch (error) {
      throw storageError(error);
    }
    return null;
  }

  /** Read at most `maxBytes` from a regular file. */
  protected readFile(path: string, maxBytes: number): Buffer {
    return this.withFile(
      this.selected(path),
      constants.O_RDONLY,
      (fd, info) => {
        if (info.size > BigInt(maxBytes)) {
          throw failure(
            "INVALID_ARGUMENT",
            "Storage file exceeds the read limit.",
          );
        }
        return readBytes(fd, Number(info.size));
      },
    );
  }

  /** Read a byte range of a regular file by position, so the bytes before `offset` are never read. */
  protected readRange(path: string, offset: number, length: number): Buffer {
    return this.withFile(
      this.selected(path),
      constants.O_RDONLY,
      (fd, info) => {
        if (BigInt(offset) >= info.size) {
          return Buffer.alloc(0);
        }
        const bytes = Buffer.alloc(
          Math.min(length, Number(info.size - BigInt(offset))),
        );
        let filled = 0;
        while (filled < bytes.length) {
          const count = readSync(
            fd,
            bytes,
            filled,
            bytes.length - filled,
            offset + filled,
          );
          if (!count) {
            throw new Error("Storage file changed during read.");
          }
          filled += count;
        }
        return bytes;
      },
    );
  }

  /**
   * Write the bytes into the file, creating it and its parent folders when missing. A replacement
   * is truncated only after the new bytes are written, and both kinds are synced before success.
   */
  protected writeFile(path: string, bytes: Buffer, append: boolean): null {
    const selected = this.selected(path);
    fsCall(() => ensureParentDirectory(selected));
    const flags =
      constants.O_WRONLY |
      constants.O_CREAT |
      (append ? constants.O_APPEND : 0);
    this.withFile(selected, flags, (fd) => {
      writeBytes(fd, bytes);
      if (!append) {
        ftruncateSync(fd, bytes.length);
      }
      fsyncSync(fd);
    });
    return null;
  }

  /**
   * Copy a regular file of any size to a new name, one chunk at a time. The destination is created exclusively, so an
   * existing file, directory or link to an existing target is never replaced. A link whose target
   * is missing is refused on POSIX, while Windows follows it and creates the target. A failed copy can leave a partial
   * destination, which is not deleted by name because the name may belong to something else.
   */
  copyFile(input: StorageTransfer): null {
    const from = this.selected(input.from);
    const to = this.selected(input.to);
    this.withFile(from, constants.O_RDONLY, (source, info) => {
      const size = Number(info.size);
      const destination = openSync(
        to,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NONBLOCK,
        FILE_MODE,
      );
      withDescriptor(destination, () => {
        const chunk = Buffer.alloc(
          Math.max(1, Math.min(size, MAX_IO_CHUNK_BYTES)),
        );
        let remaining = size;
        while (remaining > 0) {
          const count = readSync(
            source,
            chunk,
            0,
            Math.min(remaining, chunk.length),
            null,
          );
          if (!count) {
            throw new Error("Storage file changed during copy.");
          }
          writeBytes(destination, chunk.subarray(0, count));
          remaining -= count;
        }
        fsyncSync(destination);
      });
    });
    return null;
  }

  /** Rename a file or directory without replacing an existing destination. */
  move(input: StorageTransfer): null {
    const from = this.selected(input.from);
    const to = this.selected(input.to);
    if (this.rules.isBelow(from, to)) {
      throw failure("INVALID_ARGUMENT", "Cannot move a directory into itself.");
    }
    this.moveWithoutReplace(from, to);
    return null;
  }
}
