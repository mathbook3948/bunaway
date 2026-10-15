import { dlopen, ptr } from "bun:ffi";
import { BunawayError } from "@bunaway/protocol";
import { checkToast } from "#notification/platforms/toast-winrt";

const CALLBACK_DRAIN_TIMEOUT_MS = 1000;
const CALLBACK_DISPATCH_SLICE_MS = 5;
const RPC_S_CALLPENDING = 0x80010115;

/** Retain wait resources until the retry iterator completes or its consumer exits. */
function* cleanupAttempts(
  cleanup: () => void,
  deadline = performance.now() + CALLBACK_DRAIN_TIMEOUT_MS,
  retry: (error: unknown) => boolean = () => true,
): Generator<void> {
  try {
    cleanup();
    return;
  } catch (error) {
    if (!retry(error) || performance.now() >= deadline) {
      throw error;
    }
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
        yield;
        try {
          cleanup();
          return;
        } catch (error) {
          if (!retry(error) || performance.now() >= deadline) {
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

/**
 * Event revocation can leave native Release calls queued to this STA. Drain them before returning
 * from a synchronous clear/replacement, without admitting another JavaScript operation mid-mutation.
 * Only COM marshaling calls are dispatched, using a private unsignaled event and a bounded wait.
 */
export function createToastSettler(): (cleanup: () => void) => void {
  // Share one budget across the pre-mutation and post-mutation retired-owner passes.
  const deadline = performance.now() + CALLBACK_DRAIN_TIMEOUT_MS;
  return (cleanup) => {
    for (const _attempt of cleanupAttempts(
      cleanup,
      deadline,
      (error) => error instanceof BunawayError && error.code === "BUSY",
    )) {
      // Advancing the iterator pumps COM and retries on the same native stack.
    }
  };
}

/**
 * The ordinary UI pump has stopped by adapter disposal. Also yield to Bun between COM wait slices
 * so pending worker messages can complete while ownership remains intact until native Release.
 */
export async function drainToastCleanup(cleanup: () => void): Promise<void> {
  for (const _attempt of cleanupAttempts(cleanup)) {
    await Bun.sleep(0);
  }
}
