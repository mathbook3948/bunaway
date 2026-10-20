import { dlopen, read } from "bun:ffi";
import { BunawayError } from "@bunaway/plugin";
import { LIBSYSTEM_PATH } from "@bunaway/plugin/darwin";
import { normalizeMacosPath } from "#storage/platforms/macos-path";
import { NodeStorage } from "#storage/platforms/node-storage";

/** `renamex_np` flag: fail with EEXIST instead of replacing the destination. */
const RENAME_EXCL = 0x4;
const ENOENT = 2;
const EPERM = 1;
const EACCES = 13;
const EEXIST = 17;
const EXDEV = 18;
const ENOTDIR = 20;
const EINVAL = 22;
const ENAMETOOLONG = 63;
const ENOTSUP = 45;
/** Reported when a failed call left no readable errno. */
const UNKNOWN_ERRNO = -1;

/** Construct only on the host's I/O worker; imports allocate no OS resources. */
export function createStorage(): MacosStorage {
  return new MacosStorage();
}

/** Release bindings owned by one host instance. */
export function disposeStorage(storage: MacosStorage): void {
  storage.dispose();
}

function createBindings() {
  return dlopen(LIBSYSTEM_PATH, {
    renamex_np: {
      args: [
        "cstring",
        "cstring",
        "u32",
      ],
      returns: "i32",
    },
    __error: {
      args: [],
      returns: "ptr",
    },
  });
}

function failure(
  code: ConstructorParameters<typeof BunawayError>[0]["code"],
  message: string,
): BunawayError {
  return new BunawayError({
    code,
    message,
  });
}

/** The public error for a failed rename, or a plain error that keeps the raw errno. */
function moveFailure(errno: number): Error {
  switch (errno) {
    case ENOENT:
    case ENOTDIR:
      return failure("INVALID_ARGUMENT", "Storage target not found.");
    case EEXIST:
      return failure("INVALID_ARGUMENT", "Storage destination already exists.");
    case EINVAL:
    case ENAMETOOLONG:
      return failure("INVALID_ARGUMENT", "Storage move is not valid.");
    case EACCES:
    case EPERM:
      return failure("PERMISSION_DENIED", "Storage access denied.");
    case EXDEV:
    case ENOTSUP:
      return failure(
        "UNSUPPORTED",
        "Storage move requires one filesystem that supports it.",
      );
    default:
      return new Error(`Storage move failed (${errno})`);
  }
}

/**
 * macOS storage: POSIX path syntax on the shared file operations, plus a rename that refuses to
 * replace. Node's rename replaces an existing destination, so the move calls `renamex_np` with
 * `RENAME_EXCL`, which fails with EEXIST instead.
 */
export class MacosStorage extends NodeStorage {
  private readonly api: ReturnType<typeof createBindings>;

  constructor() {
    super({
      normalize: normalizeMacosPath,
      isBelow: (parent, child) => child.startsWith(`${parent}/`),
    });
    if (process.platform !== "darwin") {
      throw failure("UNSUPPORTED", "macOS storage requires Darwin.");
    }
    this.api = createBindings();
  }

  /** Read this thread's errno, which the failed call just set. */
  private errno(): number {
    const address = this.api.symbols.__error();
    if (!address) {
      throw new Error("Storage errno is unavailable.");
    }
    return read.i32(address);
  }

  /**
   * Run one rename and return its errno, or 0 on success. Bun's FFI layer can reset errno
   * between the call and the read, so a failure that reads zero is repeated once; a failed
   * rename changed nothing, so the repeat is safe.
   */
  private renameError(from: string, to: string): number {
    const call = () => this.api.symbols.renamex_np(from, to, RENAME_EXCL);
    if (call() === 0) {
      return 0;
    }
    let errno = this.errno();
    if (errno === 0) {
      if (call() === 0) {
        return 0;
      }
      errno = this.errno();
    }
    return errno === 0 ? UNKNOWN_ERRNO : errno;
  }

  /** Move within one volume; a cross-volume move fails rather than copying. */
  protected moveWithoutReplace(from: string, to: string): void {
    const errno = this.renameError(from, to);
    if (errno !== 0) {
      throw moveFailure(errno);
    }
  }

  /** Release only this adapter's bindings. */
  protected release(): void {
    this.api.close();
  }
}
