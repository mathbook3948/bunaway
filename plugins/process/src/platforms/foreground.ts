import { attemptAllAsync } from "@bunaway/plugin";
import { BunawayError } from "@bunaway/protocol";
import type { z } from "zod";
import type {
  ProcessInstance,
  ProcessResult,
  processInputSchema,
  SpawnInput,
} from "#process/contract";
import type { SpawnedChild } from "#process/platforms/spawn-child";
import { SpawnedProcessTable } from "#process/platforms/spawn-table";

const MAX_ACTIVE_PROCESSES = 8;
type ProcessInput = z.output<typeof processInputSchema>;
/** Execute one invocation; it must settle only after the process and pipes are drained. */
export type ProcessExecutor = (
  input: ProcessInput,
  signal: AbortSignal,
) => Promise<ProcessResult>;

/** Start one long-running child for the spawned-process table. */
export type ChildLauncher = (
  input: SpawnInput,
  signal: AbortSignal,
) => Promise<SpawnedChild>;

/** Own foreground processes and spawned children, with their cancellation, until the host has drained them. */
export function initialize(launch: ChildLauncher): ProcessInstance {
  return {
    active: new Map<AbortController, Promise<ProcessResult>>(),
    spawned: new SpawnedProcessTable(launch),
    disposed: false,
  };
}

/** Enforce the per-plugin process limit and translate cancellation outcomes. */
export async function runForeground(
  state: ProcessInstance,
  payload: ProcessInput,
  execute: ProcessExecutor,
  isCleanupFailure: (error: unknown) => boolean,
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
  const task = execute(payload, signal);
  state.active.set(controller, task);
  try {
    return await task;
  } catch (error) {
    if (isCleanupFailure(error)) {
      throw error;
    }
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
export async function dispose(state: ProcessInstance) {
  state.disposed = true;
  for (const controller of state.active.keys()) {
    controller.abort(
      new BunawayError({
        code: "CANCELLED",
        message: "Process adapter is disposed.",
      }),
    );
  }
  await attemptAllAsync(
    [
      async () => {
        await Promise.allSettled(state.active.values());
      },
      () => state.spawned.dispose(),
    ],
    "Process adapter cleanup failed.",
  );
}
