import { BunawayError } from "@bunaway/plugin";

const STATUS_PENDING = 0;
const STATUS_DONE = 1;
const STATUS_FAILED = 2;
const STATUS_BYTES = 4;
/**
 * SHAddToRecentDocs has no completion signal, and the Shell finishes part of its
 * work (the Recent shortcut and jump list updates) after the call returns. The helper
 * thread keeps pumping messages for this long before it releases its apartment.
 */
const RECENT_SETTLE_MS = 250;
/** Upper bound for the helper thread, including startup, so a stuck Shell cannot block the I/O worker forever. */
const RECENT_TIMEOUT_MS = 10_000;

/**
 * Source of the helper thread. Calling SHAddToRecentDocs from the opener's own thread
 * was observed to leave a live MTA in the process, which makes every thread without COM
 * initialization an implicit MTA member (see APTTYPE_MTA and implicit MTA in
 * https://learn.microsoft.com/windows/win32/api/objidl/ne-objidl-apttype), so the
 * invariant that the I/O worker starts uninitialized and dispose balances its
 * initialization broke. The cause inside the Shell is not documented, so the call
 * runs on a short-lived thread that owns an STA and pumps messages, the threading
 * model the Shell expects, and exits afterwards. A Windows lifecycle test checks that
 * a fresh thread still sees no apartment after add and clear. The source is inline
 * because plugin bundles have a single entry point.
 */
const RECENT_THREAD_SOURCE = `
import { dlopen, ptr } from "bun:ffi";
import { workerData } from "node:worker_threads";
const COINIT_APARTMENTTHREADED = 0x2;
const SHARD_PATHW = 0x3;
const QS_ALLINPUT = 0x4ff;
const MWMO_INPUTAVAILABLE = 0x4;
const PM_REMOVE = 0x1;
const MESSAGE_BYTES = 48;
const { signal, path, settleMs } = workerData;
const status = new Int32Array(signal);
let result = ${STATUS_FAILED};
try {
  const ole = dlopen("ole32.dll", {
    CoInitializeEx: { args: ["ptr", "u32"], returns: "i32" },
    CoUninitialize: { args: [], returns: "void" },
  });
  const shell = dlopen("shell32.dll", {
    SHAddToRecentDocs: { args: ["u32", "ptr"], returns: "void" },
  });
  const user = dlopen("user32.dll", {
    MsgWaitForMultipleObjectsEx: { args: ["u32", "ptr", "u32", "u32", "u32"], returns: "u32" },
    PeekMessageW: { args: ["ptr", "ptr", "u32", "u32", "u32"], returns: "i32" },
    TranslateMessage: { args: ["ptr"], returns: "i32" },
    DispatchMessageW: { args: ["ptr"], returns: "i64" },
  });
  try {
    if (ole.symbols.CoInitializeEx(null, COINIT_APARTMENTTHREADED) >= 0) {
      try {
        // Keep the UTF-16 buffer referenced until the call returns. A null path clears the list.
        const wide = path === null ? null : Buffer.from(path + "\\0", "utf16le");
        shell.symbols.SHAddToRecentDocs(SHARD_PATHW, wide ? ptr(wide) : null);
        const message = Buffer.alloc(MESSAGE_BYTES);
        const deadline = performance.now() + settleMs;
        for (let remaining = settleMs; remaining > 0; remaining = deadline - performance.now()) {
          user.symbols.MsgWaitForMultipleObjectsEx(0, null, Math.ceil(remaining), QS_ALLINPUT, MWMO_INPUTAVAILABLE);
          while (user.symbols.PeekMessageW(ptr(message), null, 0, 0, PM_REMOVE)) {
            user.symbols.TranslateMessage(ptr(message));
            user.symbols.DispatchMessageW(ptr(message));
          }
        }
        result = ${STATUS_DONE};
      } finally {
        ole.symbols.CoUninitialize();
      }
    }
  } finally {
    user.close();
    shell.close();
    ole.close();
  }
} finally {
  Atomics.store(status, 0, result);
  Atomics.notify(status, 0);
}
`;

function recentFailed(message: string): BunawayError {
  return new BunawayError({
    code: "INTERNAL",
    message,
  });
}

/**
 * Own the helper thread source for Shell Recent Items requests.
 * Each request runs on a short-lived STA thread; dispose releases the source URL.
 * Calls after disposal throw a `CANCELLED` error.
 */
export function createRecentDocuments() {
  let disposed = false;
  let sourceUrl: string | undefined;
  /** Block the calling I/O thread until the helper thread has released its apartment. */
  const request = (path: string | null): void => {
    if (disposed) {
      throw new BunawayError({
        code: "CANCELLED",
        message: "Opener has been disposed.",
      });
    }
    sourceUrl ??= URL.createObjectURL(
      new Blob([
        RECENT_THREAD_SOURCE,
      ]),
    );
    const signal = new SharedArrayBuffer(STATUS_BYTES);
    const status = new Int32Array(signal);
    // Bun's WorkerOptions type omits workerData, which the helper reads from node:worker_threads.
    const options: WorkerOptions & {
      workerData: unknown;
    } = {
      workerData: {
        signal,
        path,
        settleMs: RECENT_SETTLE_MS,
      },
    };
    let worker: Worker;
    try {
      worker = new Worker(sourceUrl, options);
    } catch {
      throw recentFailed("Opener could not start its Recent Items thread.");
    }
    Atomics.wait(status, 0, STATUS_PENDING, RECENT_TIMEOUT_MS);
    if (Atomics.load(status, 0) !== STATUS_DONE) {
      // A timed-out or failed helper may still hold the Shell; stop its thread.
      void worker.terminate();
      throw recentFailed("Windows could not update Recent Items.");
    }
  };
  return {
    /** Add a validated file to the user's Shell Recent Items. */
    add(path: string): void {
      request(path);
    },
    /** Clear the user's entire Shell Recent Items list with `SHAddToRecentDocs(NULL)`. */
    clear(): void {
      request(null);
    },
    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      if (sourceUrl) {
        URL.revokeObjectURL(sourceUrl);
      }
    },
  };
}
