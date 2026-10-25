import { dlopen } from "bun:ffi";
import { BunawayError } from "@bunaway/plugin";
import {
  KERNEL32,
  pick,
  win32CallError,
  withWide,
} from "@bunaway/plugin/win32";
import { retrySwap } from "#storage/platforms/node-atomic-write";
import { NodeStorage } from "#storage/platforms/node-storage";
import { normalizeForFileSystem } from "#storage/platforms/windows-path";

const ERROR_FILE_NOT_FOUND = 2;
const ERROR_PATH_NOT_FOUND = 3;
const ERROR_ACCESS_DENIED = 5;
const ERROR_NOT_SAME_DEVICE = 17;
const ERROR_SHARING_VIOLATION = 32;
const ERROR_LOCK_VIOLATION = 33;
const MOVEFILE_REPLACE_EXISTING = 0x1;
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
      message: "Storage move requires the same filesystem volume.",
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

  /** Move within one volume; a cross-volume move fails rather than copying. */
  protected moveWithoutReplace(from: string, to: string): void {
    const code = withWide(from, (source) =>
      withWide(to, (destination) =>
        win32CallError(
          () => this.api.symbols.MoveFileExW(source, destination, 0),
          () => this.api.symbols.GetLastError(),
        ),
      ),
    );
    if (code) {
      throw moveFailure(code);
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
