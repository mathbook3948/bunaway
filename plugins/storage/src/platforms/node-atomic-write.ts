import { randomBytes } from "node:crypto";
import {
  accessSync,
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  lstatSync,
  openSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { failWithCleanup } from "@bunaway/plugin";

const FILE_MODE = 0o600;
const PERMISSION_BITS = 0o777;
const CLEANUP_MESSAGE =
  "Storage write failed and its temporary file could not be removed.";

/** The pieces of an atomic replacement that the owning storage class supplies. */
export type AtomicWriteHooks = {
  /** Create the missing folders above `path`. */
  ensureParent(path: string): void;
  /** Write every byte of `bytes` to the descriptor. */
  writeAll(fd: number, bytes: Buffer): void;
  /** The error for a target that exists but is not a regular file. */
  notAFile(): Error;
  /** Replace `target` with `temporary`; both are in one directory. */
  swap(temporary: string, target: string): void;
  /** Flush the directory entry change to disk where the platform supports it. */
  syncDirectory(directory: string): void;
};

function isMissing(error: unknown): boolean {
  return error instanceof Error && Reflect.get(error, "code") === "ENOENT";
}

/**
 * The file a write to `path` ends up in. A link is followed, as the in-place write does, so the
 * replacement lands on the link target instead of replacing the link. A link whose target is
 * missing fails with the not-found error from `realpathSync`.
 */
function writeTarget(path: string): string {
  let linked: boolean;
  try {
    linked = lstatSync(path).isSymbolicLink();
  } catch (error) {
    if (isMissing(error)) {
      return path;
    }
    throw error;
  }
  return linked ? realpathSync(path) : path;
}

/** Permission bits of the file about to be replaced, or undefined when none exists yet. */
function existingMode(
  target: string,
  hooks: AtomicWriteHooks,
): number | undefined {
  let mode: number;
  try {
    const info = statSync(target);
    if (!info.isFile()) {
      throw hooks.notAFile();
    }
    mode = info.mode & PERMISSION_BITS;
  } catch (error) {
    if (isMissing(error)) {
      return undefined;
    }
    throw error;
  }
  // A swap does not need write access to the file itself, but the in-place write does; keep
  // read-only files read-only.
  accessSync(target, constants.W_OK);
  return mode;
}

/**
 * Replace the file at `path` with `bytes` through a temporary file in the same directory:
 * the bytes are written and flushed to the temporary file, which is then swapped over the target,
 * so the target holds either the old or the new contents. The temporary file is created
 * exclusively under an unpredictable name and is removed when any step fails.
 */
export function replaceAtomically(
  path: string,
  bytes: Buffer,
  hooks: AtomicWriteHooks,
): void {
  const target = writeTarget(path);
  hooks.ensureParent(target);
  const mode = existingMode(target, hooks);
  const directory = dirname(target);
  const temporary = join(
    directory,
    `.bunaway-${randomBytes(12).toString("hex")}.tmp`,
  );
  const fd = openSync(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    mode ?? FILE_MODE,
  );
  try {
    try {
      if (mode !== undefined && process.platform !== "win32") {
        fchmodSync(fd, mode);
      }
      hooks.writeAll(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    hooks.swap(temporary, target);
  } catch (error) {
    failWithCleanup(
      error,
      () =>
        rmSync(temporary, {
          force: true,
        }),
      CLEANUP_MESSAGE,
    );
  }
  hooks.syncDirectory(directory);
}

/**
 * Waits between attempts to swap the file in. A virus scanner or indexer that holds the target
 * open makes the swap fail briefly on Windows.
 */
const SWAP_RETRY_DELAYS_MS = [
  10,
  20,
  40,
  80,
  160,
];

function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

/** Run `attempt` again after a short wait while it fails with an error `isTransient` accepts. */
export function retrySwap(
  attempt: () => void,
  isTransient: (error: unknown) => boolean,
  sleep: (milliseconds: number) => void = sleepSync,
): void {
  for (let index = 0; ; index++) {
    try {
      attempt();
      return;
    } catch (error) {
      const delay = SWAP_RETRY_DELAYS_MS[index];
      if (delay === undefined || !isTransient(error)) {
        throw error;
      }
      sleep(delay);
    }
  }
}
