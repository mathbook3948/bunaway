import { dlopen, type Pointer, ptr, read, toArrayBuffer } from "bun:ffi";
import { BunawayError } from "@bunaway/plugin";
import type { UserDirectory } from "./contract.ts";

const KF_FLAG_DONT_VERIFY = 0x4000;
const MAX_PATH_WCHAR_BYTES = 32768 * 2;
// Keep the SDK's readable GUID spelling; convert the first three fields at the ABI boundary.
const directories: Record<UserDirectory, string> = {
  home: "5E6C858F-0E22-4760-9AFE-EA3317B67173",
  documents: "FDD39AD0-238F-46AF-ADB4-6C85480369C7",
  downloads: "374DE290-123F-4565-9164-39C4925E467B",
  desktop: "B4BFCC3A-DB2C-424C-B029-7FE99A87C641",
  pictures: "33E28130-4E1E-4676-835A-98395C3BC3BB",
  music: "4BD8D571-6D19-48D3-BE97-422220080E43",
  videos: "18989B1D-99B5-455B-841C-AB7C74E4DDFC",
};

/** Encode the Windows SDK's GUID into its mixed-endian native memory representation. */
export function knownFolderId(directory: UserDirectory): Buffer {
  const id = Buffer.from(directories[directory].replaceAll("-", ""), "hex");
  id.writeUInt32LE(id.readUInt32BE(0), 0);
  id.writeUInt16LE(id.readUInt16BE(4), 4);
  id.writeUInt16LE(id.readUInt16BE(6), 6);
  return id;
}

/** Query current-user shell paths, preserving redirection, and own native allocation cleanup. */
export class WindowsKnownFolders {
  private readonly shell = dlopen("shell32.dll", {
    SHGetKnownFolderPath: {
      args: [
        "ptr",
        "u32",
        "u64",
        "ptr",
      ],
      returns: "i32",
    },
  });
  private readonly ole = this.createAllocator();
  private disposed = false;

  private createAllocator() {
    try {
      return dlopen("ole32.dll", {
        CoTaskMemFree: {
          args: [
            "ptr",
          ],
          returns: "void",
        },
      });
    } catch (error) {
      this.shell.close();
      throw error;
    }
  }

  /** Return the configured path without verifying existence or creating directories. */
  get(directory: UserDirectory): string {
    if (this.disposed) {
      throw new BunawayError({
        code: "CANCELLED",
        message: "Path adapter is disposed.",
      });
    }
    const id = knownFolderId(directory);
    const output = new BigUint64Array(1);
    try {
      if (
        this.shell.symbols.SHGetKnownFolderPath(
          ptr(id),
          KF_FLAG_DONT_VERIFY,
          0n,
          ptr(output),
        ) < 0 ||
        !output[0]
      ) {
        throw new BunawayError({
          code: "INTERNAL",
          message: "Windows could not resolve the user directory.",
        });
      }
      // Windows owns this WCHAR allocation; all reads are bounded before copying it to JavaScript.
      const address = Number(output[0]) as Pointer;
      let length = 0;
      while (length < MAX_PATH_WCHAR_BYTES && read.u16(address, length)) {
        length += 2;
      }
      if (length >= MAX_PATH_WCHAR_BYTES) {
        throw new BunawayError({
          code: "INTERNAL",
          message: "Windows user directory path is too long.",
        });
      }
      return Buffer.from(toArrayBuffer(address, 0, length)).toString("utf16le");
    } finally {
      if (output[0]) {
        this.ole.symbols.CoTaskMemFree(Number(output[0]) as Pointer);
      }
    }
  }

  /** Release only this adapter's native bindings; repeated cleanup is safe. */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.shell.close();
    this.ole.close();
  }
}
