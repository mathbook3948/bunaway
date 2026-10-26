import { dlopen, ptr } from "bun:ffi";
import { KERNEL32, pick } from "@bunaway/plugin/win32";
import { BunawayError } from "@bunaway/protocol";

const ERROR_SUCCESS = 0;
const ERROR_INSUFFICIENT_BUFFER = 122;
const APPMODEL_ERROR_NO_PACKAGE = 15700;
const UTF16_UNIT_BYTES = 2;

/** The two package queries the check needs; a test supplies fakes without loading kernel32. */
export interface PackageQueries {
  /** The `GetCurrentPackagePath` result, or `null` when the process has no package identity. */
  packagePath(): string | null;
  /** The running host executable's full path. */
  executablePath(): string;
}

/** Whether `child` is `folder` itself or lies below it; Windows paths compare case-insensitively. */
export function isInsideFolder(child: string, folder: string): boolean {
  const normalize = (path: string) =>
    path.replaceAll("/", "\\").replace(/\\+$/, "").toLowerCase();
  const root = normalize(folder);
  const target = normalize(child);
  return target === root || target.startsWith(`${root}\\`);
}

/**
 * Whether this process was installed from an MSIX package. Package identity alone does not decide
 * it: a sparse package gives the process an identity while its executable stays in an unpackaged
 * folder the package does not own, so the executable must also lie inside the package folder.
 */
export function isManagedByStore(queries: PackageQueries): boolean {
  const packagePath = queries.packagePath();
  return (
    packagePath !== null &&
    isInsideFolder(queries.executablePath(), packagePath)
  );
}

function queryError(code: number): BunawayError {
  return new BunawayError({
    code: "INTERNAL",
    message: "Windows could not query the app package identity.",
    details: {
      win32Error: code,
    },
  });
}

/**
 * Query kernel32 for the package folder. The library is opened for the one query and closed
 * before returning, so no handle outlives the call.
 */
export function createPackageQueries(): PackageQueries {
  return {
    executablePath: () => process.execPath,
    packagePath() {
      const kernel = dlopen(
        "kernel32.dll",
        pick(KERNEL32, "GetCurrentPackagePath"),
      );
      try {
        const units = new Uint32Array(1);
        // The first call with a zero-length buffer reports the length in UTF-16 units, NUL included.
        const sizeResult = kernel.symbols.GetCurrentPackagePath(
          ptr(units),
          null,
        );
        if (sizeResult === APPMODEL_ERROR_NO_PACKAGE) {
          return null;
        }
        if (sizeResult !== ERROR_INSUFFICIENT_BUFFER) {
          throw queryError(sizeResult);
        }
        const [capacity = 0] = units;
        const buffer = Buffer.alloc(capacity * UTF16_UNIT_BYTES);
        const result = kernel.symbols.GetCurrentPackagePath(
          ptr(units),
          ptr(buffer),
        );
        if (result !== ERROR_SUCCESS) {
          throw queryError(result);
        }
        // On success the count includes the terminating NUL, which the string must not keep.
        const [written = 0] = units;
        return buffer.toString(
          "utf16le",
          0,
          Math.max(written - 1, 0) * UTF16_UNIT_BYTES,
        );
      } finally {
        kernel.close();
      }
    },
  };
}
