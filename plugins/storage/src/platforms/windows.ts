import { dlopen } from "bun:ffi";
import { lstatSync, type Stats } from "node:fs";
import { BunawayError } from "@bunaway/plugin";
import {
  KERNEL32,
  pick,
  win32CallError,
  withWide,
} from "@bunaway/plugin/win32";
import { retrySwap } from "#storage/platforms/node-atomic-write";
import {
  isMissing,
  NodeStorage,
  storageError,
} from "#storage/platforms/node-storage";
import { normalizeForFileSystem } from "#storage/platforms/windows-path";

const ERROR_FILE_NOT_FOUND = 2;
const ERROR_PATH_NOT_FOUND = 3;
const ERROR_ACCESS_DENIED = 5;
const ERROR_NOT_SAME_DEVICE = 17;
const ERROR_SHARING_VIOLATION = 32;
const ERROR_LOCK_VIOLATION = 33;
const MOVEFILE_REPLACE_EXISTING = 0x1;
const MOVEFILE_COPY_ALLOWED = 0x2;
const MOVEFILE_WRITE_THROUGH = 0x8;
const ERROR_FILE_EXISTS = 80;
const ERROR_ALREADY_EXISTS = 183;
const ERROR_INVALID_NAME = 123;
const ERROR_FILENAME_EXCED_RANGE = 206;

/** Initialize bindings only when the host activates this platform instance. */
export function createStorage(): WindowsStorage {
  return new WindowsStorage();
}

/** Release the bindings owned by one host instance. */
export function disposeStorage(storage: WindowsStorage): void {
  storage.dispose();
}

/** Whether anything is still at `path`, links counted as entries and not followed. */
function entryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    // Only absence answers no; an unreadable path is reported as still there.
    return !isMissing(error);
  }
}

function moveFailure(code: number): Error {
  if (code === ERROR_FILE_NOT_FOUND || code === ERROR_PATH_NOT_FOUND) {
    return new BunawayError({
      code: "INVALID_ARGUMENT",
      message: "Storage target not found.",
    });
  }
  if (code === ERROR_FILE_EXISTS || code === ERROR_ALREADY_EXISTS) {
    return new BunawayError({
      code: "INVALID_ARGUMENT",
      message: "Storage destination already exists.",
    });
  }
  if (code === ERROR_ACCESS_DENIED) {
    return new BunawayError({
      code: "PERMISSION_DENIED",
      message: "Storage access denied.",
    });
  }
  if (code === ERROR_NOT_SAME_DEVICE) {
    return new BunawayError({
      code: "UNSUPPORTED",
      message: "Storage move across volumes was not completed by the OS.",
    });
  }
  if (code === ERROR_INVALID_NAME || code === ERROR_FILENAME_EXCED_RANGE) {
    return new BunawayError({
      code: "INVALID_ARGUMENT",
      message: "Storage path is not valid.",
    });
  }
  return new Error(`Storage move failed (${code})`);
}

/** Sharing and lock violations are access failures that a short wait can clear. */
function swapFailure(code: number): Error {
  if (code === ERROR_SHARING_VIOLATION || code === ERROR_LOCK_VIOLATION) {
    return new BunawayError({
      code: "PERMISSION_DENIED",
      message: "Storage access denied.",
    });
  }
  return code === ERROR_ACCESS_DENIED ||
    code === ERROR_FILE_NOT_FOUND ||
    code === ERROR_PATH_NOT_FOUND ||
    code === ERROR_INVALID_NAME ||
    code === ERROR_FILENAME_EXCED_RANGE
    ? moveFailure(code)
    : new Error(`Storage replace failed (${code})`);
}

/**
 * Windows storage: Windows path syntax on the shared file operations, plus a rename that
 * refuses to replace. Node's rename replaces an existing destination, so the move calls
 * `MoveFileExW` without the replace flag, which fails with ERROR_ALREADY_EXISTS instead.
 */
export class WindowsStorage extends NodeStorage {
  private readonly api = dlopen(
    "kernel32.dll",
    pick(KERNEL32, "MoveFileExW", "GetLastError"),
  );

  constructor() {
    super({
      normalize: normalizeForFileSystem,
      // Windows compares names without regard to case. Both paths come from `normalize`, so they
      // carry the same kind of prefix.
      isBelow: (parent, child) =>
        child.toUpperCase().startsWith(`${parent.toUpperCase()}\\`),
    });
  }

  /**
   * Move without replacing. Within one volume this is a plain rename that keeps links and
   * directories as they are. Across volumes only a regular file moves, by the OS copying it and
   * deleting the source; links and directories stay `UNSUPPORTED` because the copy would follow a
   * link or has no single call for a tree.
   */
  protected moveWithoutReplace(from: string, to: string): void {
    // A same-volume rename always runs first, so its behavior does not depend on the copy path.
    const code = this.moveFile(from, to, 0);
    if (code === 0) {
      return;
    }
    if (code !== ERROR_NOT_SAME_DEVICE) {
      throw moveFailure(code);
    }
    this.requireRegularFile(from);
    const copyCode = this.moveFile(
      from,
      to,
      MOVEFILE_COPY_ALLOWED | MOVEFILE_WRITE_THROUGH,
    );
    if (copyCode !== 0) {
      throw moveFailure(copyCode);
    }
    // When the copy succeeds but the source cannot be deleted, the OS can still report success.
    // The move then did not happen, so report it and leave both files for the app to resolve.
    if (entryExists(from)) {
      throw new BunawayError({
        code: "PERMISSION_DENIED",
        message:
          "Storage move copied the file but could not remove the source.",
      });
    }
  }

  /**
   * One `MoveFileExW` call. `flags` 0 is a plain rename that fails across volumes;
   * `MOVEFILE_COPY_ALLOWED` lets the OS copy then delete. Returns the Win32 error code, 0 on success.
   */
  private moveFile(from: string, to: string, flags: number): number {
    return withWide(from, (source) =>
      withWide(to, (destination) =>
        win32CallError(
          () => this.api.symbols.MoveFileExW(source, destination, flags),
          () => this.api.symbols.GetLastError(),
        ),
      ),
    );
  }

  /** Reject a link, directory or other non-file source before any copy starts. */
  private requireRegularFile(path: string): void {
    let stats: Stats;
    try {
      stats = lstatSync(path);
    } catch (error) {
      throw storageError(error);
    }
    if (!stats.isFile()) {
      throw new BunawayError({
        code: "UNSUPPORTED",
        message:
          "Storage move across volumes supports regular files only; use copyDirectory and removeRecursive for directories.",
      });
    }
  }

  /**
   * Replace `target` and return only after the move reached the disk. A sharing conflict with a
   * scanner or indexer is retried; a read-only target stays an access failure.
   */
  protected override swapIn(temporary: string, target: string): void {
    retrySwap(
      () => {
        const code = withWide(temporary, (source) =>
          withWide(target, (destination) =>
            win32CallError(
              () =>
                this.api.symbols.MoveFileExW(
                  source,
                  destination,
                  MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
                ),
              () => this.api.symbols.GetLastError(),
            ),
          ),
        );
        if (code) {
          throw swapFailure(code);
        }
      },
      (error) =>
        error instanceof BunawayError && error.code === "PERMISSION_DENIED",
    );
  }

  /** Windows cannot open a folder to flush it; the write-through move already did. */
  protected override syncDirectory(): void {}

  /** Release only this adapter's bindings. */
  protected release(): void {
    this.api.close();
  }
}
