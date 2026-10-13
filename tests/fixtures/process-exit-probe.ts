import { dlopen } from "bun:ffi";
import assert from "node:assert/strict";

const SYNCHRONIZE = 0x00100000;
const WAIT_OBJECT_0 = 0;
const WAIT_TIMEOUT = 0x102;

/** Capture running-child identity before cancellation and test termination without confusing PID existence with liveness. */
export function processExitProbe(pid: number) {
  if (process.platform !== "win32") {
    return {
      exited() {
        try {
          process.kill(pid, 0);
          return false;
        } catch (error) {
          if (
            error instanceof Error &&
            "code" in error &&
            error.code === "ESRCH"
          ) {
            return true;
          }
          throw error;
        }
      },
      dispose() {},
    };
  }
  const api = dlopen("kernel32.dll", {
    OpenProcess: {
      args: [
        "u32",
        "i32",
        "u32",
      ],
      returns: "u64",
    },
    WaitForSingleObject: {
      args: [
        "u64",
        "u32",
      ],
      returns: "u32",
    },
    CloseHandle: {
      args: [
        "u64",
      ],
      returns: "i32",
    },
  });
  const handle = api.symbols.OpenProcess(SYNCHRONIZE, 0, pid);
  if (handle === 0n) {
    api.close();
    throw new Error("Could not capture the child's Windows process handle.");
  }
  let disposed = false;
  return {
    exited() {
      assert(!disposed);
      const state = api.symbols.WaitForSingleObject(handle, 0);
      assert(
        state === WAIT_OBJECT_0 || state === WAIT_TIMEOUT,
        "Windows process wait failed.",
      );
      return state === WAIT_OBJECT_0;
    },
    dispose() {
      if (!disposed) {
        disposed = true;
        try {
          assert(
            api.symbols.CloseHandle(handle),
            "Windows process handle close failed.",
          );
        } finally {
          api.close();
        }
      }
    },
  };
}
