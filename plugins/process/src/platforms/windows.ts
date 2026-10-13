import type { NativeAdapter, NativeEnvironment } from "@bunaway/plugin";
import { BunawayError } from "@bunaway/protocol";
import type { z } from "zod";
import type { ProcessResult, processOperations } from "../contract.ts";
import { runProcess } from "../run.ts";

const MAX_ACTIVE_PROCESSES = 8;
/** Own foreground processes on the existing cancellable host execution path. */
export function createOperations(
  _environment: NativeEnvironment,
): NativeAdapter {
  const active = new Map<AbortController, Promise<ProcessResult>>();
  let disposed = false;
  return {
    execute() {
      throw new BunawayError({
        code: "UNSUPPORTED",
        message: "Process operations require asynchronous host execution.",
      });
    },
    async executeUI(operation, input, _source, context) {
      if (disposed) {
        throw new BunawayError({
          code: "CANCELLED",
          message: "Process adapter is disposed.",
        });
      }
      if (operation !== "process.run") {
        throw new BunawayError({
          code: "UNSUPPORTED",
          message: "Host operation is not registered.",
        });
      }
      if (active.size >= MAX_ACTIVE_PROCESSES) {
        throw new BunawayError({
          code: "BUSY",
          message: "Too many process invocations.",
        });
      }
      // The SDK has parsed the schema and resolved defaults before entering the adapter.
      const payload = input as z.output<typeof processOperations.run.input>;
      context.signal?.throwIfAborted();
      const controller = new AbortController();
      const signal = AbortSignal.any([
        controller.signal,
        ...(context.signal
          ? [
              context.signal,
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
      active.set(controller, task);
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
        active.delete(controller);
      }
    },
    async dispose() {
      disposed = true;
      for (const controller of active.keys()) {
        controller.abort(
          new BunawayError({
            code: "CANCELLED",
            message: "Process adapter is disposed.",
          }),
        );
      }
      await Promise.allSettled(active.values());
    },
  };
}
