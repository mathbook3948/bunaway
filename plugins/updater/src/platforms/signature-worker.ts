import { BunawayError } from "@bunaway/protocol";
import { fail } from "#updater/request";

/** Start a worker from module source; the seam lets tests run any source. */
export function startWorker(source: string): {
  worker: Worker;
  release(): void;
} {
  const url = URL.createObjectURL(
    new Blob(
      [
        source,
      ],
      {
        type: "text/javascript",
      },
    ),
  );
  try {
    return {
      worker: new Worker(url),
      release: () => URL.revokeObjectURL(url),
    };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

/**
 * Send one request to a fresh worker running `source` and wait for its one reply.
 *
 * The caller leaves at once on abort, a worker error or the reply. An aborted worker is not
 * terminated: it may be inside a native call, and stopping its thread there would skip the
 * cleanup that follows the call (the trust provider state must be closed). It keeps its slot in
 * `workers` until it replies or fails, and only then is terminated. At `limit` a request is
 * refused with `BUSY`, so slow checks cannot pile up. The owner terminates whatever remains on
 * dispose.
 */
export async function requestFromWorker(
  options: {
    source: string;
    request: unknown;
    signal: AbortSignal;
    workers: Set<Worker>;
    limit: number;
  },
  start: typeof startWorker = startWorker,
): Promise<unknown> {
  const { source, request, signal, workers, limit } = options;
  signal.throwIfAborted();
  if (workers.size >= limit) {
    throw fail(
      "INTERNAL",
      "verifierBusy",
      "Too many update package signature checks are running.",
    );
  }
  const { worker, release } = start(source);
  workers.add(worker);
  return new Promise((resolve, reject) => {
    let settled = false;
    let retired = false;
    const settle = (action: () => void) => {
      if (!settled) {
        settled = true;
        signal.removeEventListener("abort", onAbort);
        action();
      }
    };
    // The worker has no native call in flight any more: free its slot and thread.
    const retire = () => {
      if (!retired) {
        retired = true;
        release();
        workers.delete(worker);
        void worker.terminate();
      }
    };
    const failWorker = () => {
      settle(() =>
        reject(
          new BunawayError({
            code: "INTERNAL",
            message: "Update package signature check failed.",
          }),
        ),
      );
      retire();
    };
    const onAbort = () => settle(() => reject(signal.reason));
    signal.addEventListener("abort", onAbort, {
      once: true,
    });
    worker.onmessage = (event: MessageEvent) => {
      settle(() => resolve(event.data));
      retire();
    };
    worker.onerror = failWorker;
    worker.onmessageerror = failWorker;
    worker.addEventListener("close", failWorker);
    try {
      worker.postMessage(request);
    } catch {
      failWorker();
    }
  });
}
