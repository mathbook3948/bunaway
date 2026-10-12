import { dlopen, type Pointer, ptr, read, toArrayBuffer } from "bun:ffi";
import { BunawayError } from "@bunaway/plugin";
import type { UserDirectory } from "./contract.ts";

const KF_FLAG_DONT_VERIFY = 0x4000;
const MAX_PATH_WCHAR_BYTES = 32768 * 2;
// GUID memory uses little endian for Data1, Data2 and Data3 and byte order for Data4.
const directories: Record<UserDirectory, string> = {
  home: "8f856c5e220e60479afeea3317b67173",
  documents: "d09ad3fd8f23af46adb46c85480369c7",
  downloads: "90e24d373f126545916439c4925e467b",
  desktop: "3accbfb42cdb4c42b0297fe99a87c641",
  pictures: "3018e2331e4e7646835a98395c3bc3bb",
  music: "71d5d84b196dd348be97422220080e43",
  videos: "1dbb9818b5995b45841cab7c74e4ddfc",
};

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
    const id = Buffer.from(directories[directory], "hex");
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
