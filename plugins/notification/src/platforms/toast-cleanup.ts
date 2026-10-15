import { dlopen, ptr } from "bun:ffi";
import { BunawayError } from "@bunaway/protocol";
import { checkToast } from "#notification/platforms/toast-winrt";

const CALLBACK_DRAIN_TIMEOUT_MS = 1000;
const CALLBACK_DISPATCH_SLICE_MS = 5;
const RPC_S_CALLPENDING = 0x80010115;

/**
 * The host's ordinary UI pump has stopped by adapter disposal. Temporarily dispatch COM marshaling
 * calls on this STA while retrying retained cleanup. No arbitrary input messages are dispatched.
 * A private unsignaled event supplies a valid wait handle; each COM wait ends at its short timeout.
 */
export async function drainToastCleanup(cleanup: () => void): Promise<void> {
  try {
    cleanup();
    return;
  } catch {
    /* Retry while the same apartment and resources remain alive. */
  }
  const kernel = dlopen("kernel32.dll", {
    CreateEventW: {
      args: [
        "ptr",
        "i32",
        "i32",
        "ptr",
      ],
      returns: "ptr",
    },
    CloseHandle: {
      args: [
        "ptr",
      ],
      returns: "i32",
    },
  });
  const event = kernel.symbols.CreateEventW(null, 1, 0, null);
  if (!event) {
    kernel.close();
    throw new BunawayError({
      code: "INTERNAL",
      message: "Could not allocate toast callback cleanup wait.",
    });
  }
  try {
    const ole = dlopen("ole32.dll", {
      CoWaitForMultipleHandles: {
        args: [
          "u32",
          "u32",
          "u32",
          "ptr",
          "ptr",
        ],
        returns: "i32",
      },
    });
    try {
      const handles = new BigUint64Array([
        BigInt(event),
      ]);
      const index = new Uint32Array(1);
      const deadline = performance.now() + CALLBACK_DRAIN_TIMEOUT_MS;
      for (;;) {
        const result = ole.symbols.CoWaitForMultipleHandles(
          0,
          CALLBACK_DISPATCH_SLICE_MS,
          1,
          ptr(handles),
          ptr(index),
        );
        if (result >>> 0 !== RPC_S_CALLPENDING) {
          checkToast(result, "CoWaitForMultipleHandles");
        }
        await Bun.sleep(0);
        try {
          cleanup();
          return;
        } catch (error) {
          if (performance.now() >= deadline) {
            throw error;
          }
        }
      }
    } finally {
      ole.close();
    }
  } finally {
    kernel.symbols.CloseHandle(event);
    kernel.close();
  }
}
