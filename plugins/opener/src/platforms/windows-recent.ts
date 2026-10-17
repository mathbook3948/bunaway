import { dlopen, ptr } from "bun:ffi";
import { BunawayError } from "@bunaway/plugin";

// Layout of the Int32 state shared with a helper thread.
const SLOT_PHASE = 0;
const SLOT_STAGE = 1;
const SLOT_HRESULT = 2;
const SLOT_FINISHED = 3;
const STATE_SLOTS = 4;
const STATE_BYTES = STATE_SLOTS * Int32Array.BYTES_PER_ELEMENT;
const PHASE_STARTING = 0;
/** SHAddToRecentDocs returned; the helper may still be settling. */
const PHASE_REQUESTED = 1;
const PHASE_FAILED = 2;
const STAGE_LOAD = 1;
const STAGE_INITIALIZE = 2;
const STAGE_CALL = 3;
const STAGE_SETTLE = 4;
const STAGE_NAMES: Readonly<Record<number, string>> = {
  [STAGE_LOAD]: "load",
  [STAGE_INITIALIZE]: "initialize",
  [STAGE_CALL]: "call",
  [STAGE_SETTLE]: "settle",
};
/**
 * SHAddToRecentDocs has no completion signal, and the Shell finishes part of its
 * work (the Recent shortcut and jump list updates) after the call returns. The helper
 * thread keeps pumping messages for this long before it releases its apartment.
 * Callers do not wait for it.
 */
const RECENT_SETTLE_MS = 250;
/** Upper bound for helper startup and the Shell call, so a stuck Shell cannot block the I/O thread forever. */
const RECENT_REQUEST_TIMEOUT_MS = 10_000;
/** Upper bound for dispose to wait for helpers that are still settling or stuck. */
const RECENT_DISPOSE_TIMEOUT_MS = 5_000;
const WAIT_POLL_MS = 5;
const QS_ALLINPUT = 0x4ff;
const MWMO_INPUTAVAILABLE = 0x4;
const PM_REMOVE = 0x1;
const MESSAGE_BYTES = 48;

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
 *
 * The helper reports only through the shared state: the phase flips to REQUESTED when
 * the Shell call returns, a failure records its stage and HRESULT, and FINISHED is set
 * last, after CoUninitialize, whatever happened. It never throws to its owner.
 */
const RECENT_THREAD_SOURCE = `
import { dlopen, ptr } from "bun:ffi";
import { workerData } from "node:worker_threads";
const COINIT_APARTMENTTHREADED = 0x2;
const SHARD_PATHW = 0x3;
// Everything, including reading the shared state, runs inside the try so a failure at
// any stage is reported. Without the shared buffer nothing can be reported.
let state;
const publish = (slot, value) => {
  Atomics.store(state, slot, value);
  Atomics.notify(state, slot);
};
let stage = ${STAGE_LOAD};
try {
  const { sharedState, path, settleMs } = workerData;
  state = new Int32Array(sharedState);
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
    stage = ${STAGE_INITIALIZE};
    const initialized = ole.symbols.CoInitializeEx(null, COINIT_APARTMENTTHREADED);
    if (initialized < 0) {
      state[${SLOT_HRESULT}] = initialized;
      state[${SLOT_STAGE}] = stage;
      publish(${SLOT_PHASE}, ${PHASE_FAILED});
    } else {
      try {
        stage = ${STAGE_CALL};
        // Keep the UTF-16 buffer referenced until the call returns. A null path clears the list.
        const wide = path === null ? null : Buffer.from(path + "\\0", "utf16le");
        shell.symbols.SHAddToRecentDocs(SHARD_PATHW, wide ? ptr(wide) : null);
        publish(${SLOT_PHASE}, ${PHASE_REQUESTED});
        stage = ${STAGE_SETTLE};
        const message = Buffer.alloc(${MESSAGE_BYTES});
        const deadline = performance.now() + settleMs;
        for (let remaining = settleMs; remaining > 0; remaining = deadline - performance.now()) {
          user.symbols.MsgWaitForMultipleObjectsEx(0, null, Math.ceil(remaining), ${QS_ALLINPUT}, ${MWMO_INPUTAVAILABLE});
          while (user.symbols.PeekMessageW(ptr(message), null, 0, 0, ${PM_REMOVE})) {
            user.symbols.TranslateMessage(ptr(message));
            user.symbols.DispatchMessageW(ptr(message));
          }
        }
      } finally {
        ole.symbols.CoUninitialize();
      }
    }
  } finally {
    user.close();
    shell.close();
    ole.close();
  }
} catch {
  if (state) {
    state[${SLOT_STAGE}] = stage;
    if (Atomics.load(state, ${SLOT_PHASE}) === ${PHASE_STARTING}) {
      publish(${SLOT_PHASE}, ${PHASE_FAILED});
    }
  }
} finally {
  if (state) {
    publish(${SLOT_FINISHED}, 1);
  }
}
`;

/** One helper thread and the state it shares with its owner. */
type Helper = {
  worker: Worker;
  state: Int32Array;
};

function isFinished(helper: Helper): boolean {
  return Atomics.load(helper.state, SLOT_FINISHED) === 1;
}

/** Create an error that keeps its trusted diagnostic cause out of the public message. */
function withCause(error: BunawayError, cause: unknown): BunawayError {
  error.cause = cause;
  return error;
}

type WaitOutcome = "done" | "timeout" | "aborted";

/**
 * Wait on the calling STA thread until `done` is true, the timeout passes or `signal`
 * aborts, pumping its messages so the apartment stays responsive. The loop is
 * synchronous, so an abort is observed only once the signal's state has been updated;
 * an abort that depends on this thread's event loop is seen late or not at all.
 */
function waitPumping(
  done: () => boolean,
  timeoutMs: number,
  signal?: AbortSignal,
): WaitOutcome {
  const user = dlopen("user32.dll", {
    MsgWaitForMultipleObjectsEx: {
      args: [
        "u32",
        "ptr",
        "u32",
        "u32",
        "u32",
      ],
      returns: "u32",
    },
    PeekMessageW: {
      args: [
        "ptr",
        "ptr",
        "u32",
        "u32",
        "u32",
      ],
      returns: "i32",
    },
    TranslateMessage: {
      args: [
        "ptr",
      ],
      returns: "i32",
    },
    DispatchMessageW: {
      args: [
        "ptr",
      ],
      returns: "i64",
    },
  });
  try {
    const message = Buffer.alloc(MESSAGE_BYTES);
    const deadline = performance.now() + timeoutMs;
    while (!done()) {
      if (signal?.aborted) {
        return "aborted";
      }
      if (performance.now() >= deadline) {
        return "timeout";
      }
      user.symbols.MsgWaitForMultipleObjectsEx(
        0,
        null,
        WAIT_POLL_MS,
        QS_ALLINPUT,
        MWMO_INPUTAVAILABLE,
      );
      while (user.symbols.PeekMessageW(ptr(message), null, 0, 0, PM_REMOVE)) {
        user.symbols.TranslateMessage(ptr(message));
        user.symbols.DispatchMessageW(ptr(message));
      }
    }
    return "done";
  } finally {
    user.close();
  }
}

/**
 * Own the helper threads that call the Shell for Recent Items.
 * A request returns once SHAddToRecentDocs has returned; the helper then settles and
 * exits on its own while this object tracks it. Dispose waits for tracked helpers,
 * terminates any that do not finish, and never throws for them.
 * Calls after disposal throw a `CANCELLED` error.
 */
export function createRecentDocuments() {
  let disposed = false;
  let sourceUrl: string | undefined;
  const helpers = new Set<Helper>();

  /**
   * Run one Shell call on a helper and wait, pumping this thread's messages, only
   * until the call has returned.
   * @throws CANCELLED when disposed or already aborted (no helper is created), or when
   * the abort arrives while waiting; then the Shell call may already be in progress and
   * the request may still be applied.
   * @throws INTERNAL with a diagnostic cause when the helper cannot start or fails.
   * @throws TIMEOUT when the call did not return in time; the request may still be applied.
   */
  const request = (path: string | null, signal?: AbortSignal): void => {
    if (disposed) {
      throw new BunawayError({
        code: "CANCELLED",
        message: "Opener has been disposed.",
      });
    }
    if (signal?.aborted) {
      throw new BunawayError({
        code: "CANCELLED",
        message: "Recent Items request cancelled.",
      });
    }
    for (const helper of helpers) {
      if (isFinished(helper)) {
        helpers.delete(helper);
      }
    }
    sourceUrl ??= URL.createObjectURL(
      new Blob([
        RECENT_THREAD_SOURCE,
      ]),
    );
    const sharedState = new SharedArrayBuffer(STATE_BYTES);
    // Bun's WorkerOptions type omits workerData, which the helper reads from node:worker_threads.
    const options: WorkerOptions & {
      workerData: unknown;
    } = {
      workerData: {
        sharedState,
        path,
        settleMs: RECENT_SETTLE_MS,
      },
    };
    let worker: Worker;
    try {
      worker = new Worker(sourceUrl, options);
    } catch (error) {
      throw withCause(
        new BunawayError({
          code: "INTERNAL",
          message: "Opener could not start its Recent Items thread.",
        }),
        error,
      );
    }
    const helper: Helper = {
      worker,
      state: new Int32Array(sharedState),
    };
    helpers.add(helper);
    const phase = () => Atomics.load(helper.state, SLOT_PHASE);
    const outcome = waitPumping(
      () => phase() !== PHASE_STARTING,
      RECENT_REQUEST_TIMEOUT_MS,
      signal,
    );
    if (outcome !== "done") {
      // Terminate may not interrupt a blocked native call, so the helper stays tracked.
      void worker.terminate();
      throw outcome === "aborted"
        ? new BunawayError({
            code: "CANCELLED",
            message: "Recent Items request cancelled and may still be applied.",
          })
        : new BunawayError({
            code: "TIMEOUT",
            message:
              "Windows Recent Items request timed out and may still be applied.",
          });
    }
    if (phase() === PHASE_FAILED) {
      throw withCause(
        new BunawayError({
          code: "INTERNAL",
          message: "Windows could not update Recent Items.",
        }),
        {
          stage:
            STAGE_NAMES[Atomics.load(helper.state, SLOT_STAGE)] ?? "unknown",
          hresult: Atomics.load(helper.state, SLOT_HRESULT) >>> 0,
        },
      );
    }
  };
  return {
    /** Add a validated file to the user's Shell Recent Items. */
    add(path: string, signal?: AbortSignal): void {
      request(path, signal);
    },
    /** Clear the user's entire Shell Recent Items list with `SHAddToRecentDocs(NULL)`. */
    clear(signal?: AbortSignal): void {
      request(null, signal);
    },
    /**
     * Wait up to a bound for tracked helpers to finish settling, then terminate those
     * still running. A terminated helper's Shell request may or may not have been applied.
     */
    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      try {
        if (helpers.size > 0) {
          waitPumping(
            () =>
              [
                ...helpers,
              ].every(isFinished),
            RECENT_DISPOSE_TIMEOUT_MS,
          );
        }
        for (const helper of helpers) {
          if (!isFinished(helper)) {
            void helper.worker.terminate();
          }
        }
        helpers.clear();
      } finally {
        if (sourceUrl) {
          URL.revokeObjectURL(sourceUrl);
        }
      }
    },
  };
}
