import { dlopen, ptr } from "bun:ffi";
import { BunawayError } from "@bunaway/plugin";

const SHELL_EXECUTE_INFO_BYTES = 112;
const SEE_MASK_NOASYNC = 0x00000100;
const SEE_MASK_FLAG_NO_UI = 0x00000400;
const SW_SHOWNORMAL = 1;

// The UI host owns COM initialization. This binding is used only in its STA.
export function createShell() {
  const shell = dlopen("shell32.dll", {
    ShellExecuteExW: {
      args: [
        "ptr",
      ],
      returns: "i32",
    },
  });
  const verb = Buffer.from("open\0", "utf16le");
  let disposed = false;
  return {
    open(url: string): void {
      if (disposed) {
        throw new BunawayError({
          code: "CANCELLED",
          message: "Opener has been disposed.",
        });
      }
      const target = Buffer.from(`${url}\0`, "utf16le");
      // Win64 SHELLEXECUTEINFOW: cbSize, fMask, lpVerb, lpFile and nShow.
      const request = Buffer.alloc(SHELL_EXECUTE_INFO_BYTES);
      request.writeUInt32LE(SHELL_EXECUTE_INFO_BYTES, 0);
      request.writeUInt32LE(SEE_MASK_NOASYNC | SEE_MASK_FLAG_NO_UI, 4);
      request.writeBigUInt64LE(BigInt(ptr(verb)), 16);
      request.writeBigUInt64LE(BigInt(ptr(target)), 24);
      request.writeInt32LE(SW_SHOWNORMAL, 48);
      // NOASYNC keeps buffers alive through handoff; no process handle is requested.
      if (!shell.symbols.ShellExecuteExW(ptr(request))) {
        throw new BunawayError({
          code: "INTERNAL",
          message: "Windows could not accept the browser launch request.",
        });
      }
    },
    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      shell.close();
    },
  };
}
