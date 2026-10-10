import { dlopen, ptr } from "bun:ffi";
import { BunawayError } from "@bunaway/plugin";
import { MAX_FILE_PATH_LENGTH } from "./path.ts";

const INVALID_HANDLE_VALUE = 0xffffffffffffffffn;
const GENERIC_READ = 0x80000000;
const FILE_READ_ATTRIBUTES = 0x80;
const FILE_LIST_DIRECTORY = 0x1;
const FILE_SHARE_READ = 0x1;
const FILE_SHARE_WRITE = 0x2;
const OPEN_EXISTING = 3;
const FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
const FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
const FILE_ATTRIBUTE_DIRECTORY = 0x10;
const FILE_ATTRIBUTE_REPARSE_POINT = 0x400;
const FILE_INFORMATION_BYTES = 52;
const FILE_LINK_COUNT_OFFSET = 40;
const ERROR_FILE_NOT_FOUND = 2;
const ERROR_PATH_NOT_FOUND = 3;
const ERROR_ACCESS_DENIED = 5;
const ERROR_SHARING_VIOLATION = 32;
const DEVICE_PREFIX = "\\\\?\\";
const UNC_PREFIX = "\\\\?\\UNC\\";

/** Own file handles until the synchronous OS request has been submitted. */
export function createFiles() {
  const api = dlopen("kernel32.dll", {
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
    GetFileInformationByHandle: {
      args: [
        "u64",
        "ptr",
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
    GetLastError: {
      args: [],
      returns: "u32",
    },
    CloseHandle: {
      args: [
        "u64",
      ],
      returns: "i32",
    },
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
  return {
    /** Pin and validate each parent and the file, rejecting links and path aliases. */
    withFile(path: string, request: () => void): void {
      if (disposed) {
        throw new BunawayError({
          code: "CANCELLED",
          message: "Opener has been disposed.",
        });
      }
      const parts = path.split("\\");
      const firstParent = path.startsWith("\\\\") ? 4 : 1;
      const handles: bigint[] = [];
      try {
        // Data-access handles without FILE_SHARE_DELETE pin parents against replacement.
        for (let count = firstParent; count <= parts.length; count++) {
          const isFile = count === parts.length;
          const target =
            count === 1 ? `${parts[0]}\\` : parts.slice(0, count).join("\\");
          const handle = api.symbols.CreateFileW(
            ptr(Buffer.from(`${target}\0`, "utf16le")),
            isFile ? GENERIC_READ : FILE_READ_ATTRIBUTES | FILE_LIST_DIRECTORY,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            null,
            OPEN_EXISTING,
            FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS,
            0n,
          );
          if (handle === INVALID_HANDLE_VALUE) {
            fail();
          }
          handles.push(handle);
          const info = Buffer.alloc(FILE_INFORMATION_BYTES);
          if (!api.symbols.GetFileInformationByHandle(handle, ptr(info))) {
            fail();
          }
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
          const finalPath = wide.subarray(0, length * 2).toString("utf16le");
          let actual = finalPath;
          if (finalPath.startsWith(UNC_PREFIX)) {
            actual = `\\\\${finalPath.slice(UNC_PREFIX.length)}`;
          } else if (finalPath.startsWith(DEVICE_PREFIX)) {
            actual = finalPath.slice(DEVICE_PREFIX.length);
          }
          // Exact case also protects directories with Windows case sensitivity enabled.
          if (actual !== target) {
            throw new BunawayError({
              code: "PERMISSION_DENIED",
              message:
                "Opener requires the filesystem's canonical path spelling.",
            });
          }
        }
        request();
      } finally {
        for (const handle of handles.reverse()) {
          api.symbols.CloseHandle(handle);
        }
      }
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
