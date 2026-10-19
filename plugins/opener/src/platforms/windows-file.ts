import { dlopen, ptr } from "bun:ffi";
import { BunawayError } from "@bunaway/plugin";
import { KERNEL32, pick } from "@bunaway/plugin/win32";
import { MAX_FILE_PATH_LENGTH } from "#opener/contract";

const INVALID_HANDLE_VALUE = 0xffffffffffffffffn;
const GENERIC_READ = 0x80000000;
const FILE_READ_ATTRIBUTES = 0x80;
const FILE_LIST_DIRECTORY = 0x1;
const FILE_SHARE_READ = 0x1;
const FILE_SHARE_WRITE = 0x2;
const FILE_SHARE_DELETE = 0x4;
const OPEN_EXISTING = 3;
const FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
const FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
const FILE_ATTRIBUTE_DIRECTORY = 0x10;
const FILE_ATTRIBUTE_REPARSE_POINT = 0x400;
const FILE_INFORMATION_BYTES = 52;
const FILE_LINK_COUNT_OFFSET = 40;
const FILE_VOLUME_SERIAL_OFFSET = 28;
const FILE_INDEX_OFFSET = 44;
const FILE_INDEX_BYTES = 8;
const ERROR_FILE_NOT_FOUND = 2;
const ERROR_PATH_NOT_FOUND = 3;
const ERROR_ACCESS_DENIED = 5;
const ERROR_SHARING_VIOLATION = 32;
const DEVICE_PREFIX = "\\\\?\\";
const UNC_PREFIX = "\\\\?\\UNC\\";

/** Volume serial and file index identify the checked file, not just its name. */
function fileIdentity(info: Buffer): Buffer {
  return Buffer.concat([
    info.subarray(FILE_VOLUME_SERIAL_OFFSET, FILE_VOLUME_SERIAL_OFFSET + 4),
    info.subarray(FILE_INDEX_OFFSET, FILE_INDEX_OFFSET + FILE_INDEX_BYTES),
  ]);
}

/** Rejects a directory where a file is required, and any reparse point or hard-linked file. */
function assertPlainEntry(info: Buffer, isFile: boolean): void {
  const attributes = info.readUInt32LE(0);
  if (isFile && attributes & FILE_ATTRIBUTE_DIRECTORY) {
    throw new BunawayError({
      code: "INVALID_ARGUMENT",
      message: "Opener requires a file, not a directory.",
    });
  }
  if (
    attributes & FILE_ATTRIBUTE_REPARSE_POINT ||
    (isFile && info.readUInt32LE(FILE_LINK_COUNT_OFFSET) !== 1)
  ) {
    throw new BunawayError({
      code: "PERMISSION_DENIED",
      message: "Opener paths must not contain links.",
    });
  }
}

/** Turns a final path with a Win32 device or UNC prefix back into the caller's path form. */
function stripDevicePrefix(finalPath: string): string {
  if (finalPath.startsWith(UNC_PREFIX)) {
    return `\\\\${finalPath.slice(UNC_PREFIX.length)}`;
  }
  if (finalPath.startsWith(DEVICE_PREFIX)) {
    return finalPath.slice(DEVICE_PREFIX.length);
  }
  return finalPath;
}

/** Own file handles until the synchronous OS request has been submitted. */
export function createFiles() {
  const api = dlopen("kernel32.dll", {
    ...pick(
      KERNEL32,
      "CreateFileW",
      "GetFileInformationByHandle",
      "GetFinalPathNameByHandleW",
      "GetLastError",
      "CloseHandle",
    ),
  });
  let disposed = false;
  const fail = (): never => {
    const error = api.symbols.GetLastError();
    if (error === ERROR_FILE_NOT_FOUND || error === ERROR_PATH_NOT_FOUND) {
      throw new BunawayError({
        code: "INVALID_ARGUMENT",
        message: "Opener file not found.",
        details: {
          reason: "FILE_NOT_FOUND",
        },
      });
    }
    if (error === ERROR_ACCESS_DENIED || error === ERROR_SHARING_VIOLATION) {
      throw new BunawayError({
        code: "PERMISSION_DENIED",
        message: "Opener file access denied.",
      });
    }
    throw new BunawayError({
      code: "INTERNAL",
      message: "Opener file check failed.",
    });
  };
  /** Opens one path component without following reparse points; the caller owns the handle. */
  const openComponent = (
    target: string,
    isFile: boolean,
    allowFileDelete: boolean,
  ): bigint => {
    const handle = api.symbols.CreateFileW(
      ptr(Buffer.from(`${target}\0`, "utf16le")),
      isFile ? GENERIC_READ : FILE_READ_ATTRIBUTES | FILE_LIST_DIRECTORY,
      FILE_SHARE_READ |
        FILE_SHARE_WRITE |
        (isFile && allowFileDelete ? FILE_SHARE_DELETE : 0),
      null,
      OPEN_EXISTING,
      FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS,
      0n,
    );
    if (handle === INVALID_HANDLE_VALUE) {
      fail();
    }
    return handle;
  };
  const readInformation = (handle: bigint): Buffer => {
    const info = Buffer.alloc(FILE_INFORMATION_BYTES);
    if (!api.symbols.GetFileInformationByHandle(handle, ptr(info))) {
      fail();
    }
    return info;
  };
  /** Requires the handle's final path to spell the opened path exactly. */
  const assertCanonicalPath = (handle: bigint, target: string): void => {
    const wide = Buffer.alloc(
      (MAX_FILE_PATH_LENGTH + UNC_PREFIX.length + 1) * 2,
    );
    const length = api.symbols.GetFinalPathNameByHandleW(
      handle,
      ptr(wide),
      wide.length / 2,
      0,
    );
    if (!length) {
      fail();
    }
    if (length >= wide.length / 2) {
      throw new BunawayError({
        code: "PERMISSION_DENIED",
        message: "Opener path alias denied.",
      });
    }
    // Exact case also protects directories with Windows case sensitivity enabled.
    if (
      stripDevicePrefix(wide.subarray(0, length * 2).toString("utf16le")) !==
      target
    ) {
      throw new BunawayError({
        code: "PERMISSION_DENIED",
        message: "Opener requires the filesystem's canonical path spelling.",
      });
    }
  };
  const withFile = (
    path: string,
    request: (verifyIdentity: () => void) => void,
    allowFileDelete = false,
    expectedIdentity?: Buffer,
    pinLeaf = true,
  ): void => {
    if (disposed) {
      throw new BunawayError({
        code: "CANCELLED",
        message: "Opener has been disposed.",
      });
    }
    const parts = path.split("\\");
    const firstParent = path.startsWith("\\\\") ? 4 : 1;
    const handles: bigint[] = [];
    let identity: Buffer | undefined;
    try {
      // Data-access handles without FILE_SHARE_DELETE pin parents against replacement.
      const last = pinLeaf ? parts.length : parts.length - 1;
      for (let count = firstParent; count <= last; count++) {
        const isFile = pinLeaf && count === parts.length;
        const target =
          count === 1 ? `${parts[0]}\\` : parts.slice(0, count).join("\\");
        const handle = openComponent(target, isFile, allowFileDelete);
        handles.push(handle);
        const info = readInformation(handle);
        if (isFile && allowFileDelete) {
          identity = fileIdentity(info);
          if (expectedIdentity && !identity.equals(expectedIdentity)) {
            throw new BunawayError({
              code: "PERMISSION_DENIED",
              message: "Opener file changed before recycling.",
            });
          }
        }
        assertPlainEntry(info, isFile);
        assertCanonicalPath(handle, target);
      }
      const checkedIdentity = identity;
      request(() => withFile(path, () => {}, true, checkedIdentity));
    } finally {
      for (const handle of handles.reverse()) {
        api.symbols.CloseHandle(handle);
      }
    }
  };
  return {
    /** Pin and validate each parent and file during a non-destructive Shell request. */
    withFile(path: string, request: () => void): void {
      withFile(path, request);
    },
    /**
     * Pin and validate only the parent directories of a file that may not exist yet. The
     * leaf is not checked, so a link created there after the check is not detected.
     */
    withParents(path: string, request: () => void): void {
      withFile(path, request, false, undefined, false);
    },
    /**
     * Pin parents and validate a file while allowing the Shell to move it.
     * The callback rechecks identity before deletion; Windows consumes a path, so
     * another process can still replace the leaf after that final check returns.
     */
    withTrashFile(
      path: string,
      request: (verifyIdentity: () => void) => void,
    ): void {
      withFile(path, request, true);
    },
    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      api.close();
    },
  };
}
