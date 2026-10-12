import type { NativeAdapter, NativeEnvironment } from "@bunaway/plugin";
import { BunawayError } from "@bunaway/protocol";
import type { z } from "zod";
import type { networkOperations } from "../contract.ts";
import { request } from "../http.ts";
import { exchange } from "../websocket.ts";

const MAX_ACTIVE_REQUESTS = 16;
/** Use the existing async host execution and cancellation contract; Bun owns network I/O. */
export function createOperations(
  _environment: NativeEnvironment,
): NativeAdapter {
  const active = new Set<AbortController>();
  let disposed = false;
  return {
    execute() {
      throw new BunawayError({
        code: "UNSUPPORTED",
        message: "Network operations require asynchronous host execution.",
      });
    },
    async executeUI(operation, input, _source, context) {
      if (disposed) {
        throw new BunawayError({
          code: "CANCELLED",
          message: "Network adapter is disposed.",
        });
      }
      if (active.size >= MAX_ACTIVE_REQUESTS) {
        throw new BunawayError({
          code: "BUSY",
          message: "Too many network requests.",
        });
      }
      // The SDK parsed these contracts and resolved defaults before authorizing execution.
      const payload =
        operation === "network.request"
          ? (input as z.output<typeof networkOperations.request.input>)
          : operation === "network.exchange"
            ? (input as z.output<typeof networkOperations.exchange.input>)
            : null;
      if (!payload) {
        throw new BunawayError({
          code: "UNSUPPORTED",
          message: "Host operation is not registered.",
        });
      }
      context.signal?.throwIfAborted();
      const controller = new AbortController();
      active.add(controller);
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
              message: "Network request timed out.",
            }),
          ),
        payload.timeoutMs,
      );
      try {
        return "method" in payload
          ? await request(payload, signal)
          : await exchange(payload, signal);
      } catch (error) {
        if (signal.aborted) {
          throw signal.reason instanceof BunawayError
            ? signal.reason
            : new BunawayError({
                code: "CANCELLED",
                message: "Network request was cancelled.",
              });
        }
        if (error instanceof BunawayError) {
          throw error;
        }
        throw new BunawayError({
          code: "INTERNAL",
          message: "Network request failed.",
        });
      } finally {
        clearTimeout(timer);
        active.delete(controller);
      }
    },
    dispose() {
      if (!disposed) {
        disposed = true;
        for (const controller of active) {
          controller.abort(
            new BunawayError({
              code: "CANCELLED",
              message: "Network adapter is disposed.",
            }),
          );
        }
      }
    },
  };
}
