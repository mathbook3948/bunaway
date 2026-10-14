import { BunawayError } from "@bunaway/protocol";
import type { z } from "zod";
import type { ProcessResult, processInputSchema } from "#process/contract";
import { runProcess } from "#process/platforms/windows-process";

const MAX_ACTIVE_PROCESSES = 8;
type ProcessInput = z.output<typeof processInputSchema>;

/** Own foreground processes and their cancellation until the host has drained them. */
export function initialize() {
  return {
    active: new Map<AbortController, Promise<ProcessResult>>(),
    disposed: false,
  };
}

/** Enforce the per-plugin process limit and translate cancellation outcomes. */
export async function run(
  state: ReturnType<typeof initialize>,
  payload: ProcessInput,
  requestSignal?: AbortSignal,
): Promise<ProcessResult> {
  if (state.disposed) {
    throw new BunawayError({
      code: "CANCELLED",
      message: "Process adapter is disposed.",
    });
  }
  if (state.active.size >= MAX_ACTIVE_PROCESSES) {
    throw new BunawayError({
      code: "BUSY",
      message: "Too many process invocations.",
    });
  }
  requestSignal?.throwIfAborted();
  const controller = new AbortController();
  const signal = AbortSignal.any([
    controller.signal,
    ...(requestSignal
      ? [
          requestSignal,
        ]
      : []),
  ]);
  const timer = setTimeout(
    () =>
      controller.abort(
        new BunawayError({
          code: "TIMEOUT",
          message: "Process execution timed out.",
        }),
      ),
    payload.timeoutMs,
  );
  const task = runProcess(payload, signal);
  state.active.set(controller, task);
  try {
    return await task;
  } catch (error) {
    if (signal.aborted) {
      throw signal.reason instanceof BunawayError
        ? signal.reason
        : new BunawayError({
            code: "CANCELLED",
            message: "Process execution was cancelled.",
          });
    }
    if (error instanceof BunawayError) {
      throw error;
    }
    throw new BunawayError({
      code: "INTERNAL",
      message: "Process execution failed.",
    });
  } finally {
    clearTimeout(timer);
    state.active.delete(controller);
  }
}

/** Abort owned processes and wait for their completion before releasing the state. */
export async function dispose(state: ReturnType<typeof initialize>) {
  state.disposed = true;
  for (const controller of state.active.keys()) {
    controller.abort(
      new BunawayError({
        code: "CANCELLED",
        message: "Process adapter is disposed.",
      }),
    );
  }
  await Promise.allSettled(state.active.values());
}
