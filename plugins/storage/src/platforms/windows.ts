import { dlopen } from "bun:ffi";
import { BunawayError } from "@bunaway/plugin";
import {
  KERNEL32,
  pick,
  win32CallError,
  withWide,
} from "@bunaway/plugin/win32";
import { NodeStorage } from "#storage/platforms/node-storage";
import { normalizeWindowsPath } from "#storage/platforms/windows-path";

const ERROR_FILE_NOT_FOUND = 2;
const ERROR_PATH_NOT_FOUND = 3;
const ERROR_ACCESS_DENIED = 5;
const ERROR_NOT_SAME_DEVICE = 17;
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
      normalize: normalizeWindowsPath,
      // Windows compares names without regard to case.
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

  /** Release only this adapter's bindings. */
  protected release(): void {
    this.api.close();
  }
}
