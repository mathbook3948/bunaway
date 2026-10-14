import { BunawayError } from "@bunaway/protocol";
import type { z } from "zod";
import type { exchangeInputSchema, requestInputSchema } from "./contract.ts";
import { request } from "./http.ts";
import { exchange } from "./websocket.ts";

const MAX_ACTIVE_REQUESTS = 16;
type RequestInput = z.output<typeof requestInputSchema>;
type ExchangeInput = z.output<typeof exchangeInputSchema>;

/** Own cancellable requests on the selected host thread. */
export function initialize() {
  return {
    active: new Map<AbortController, Promise<unknown>>(),
    disposed: false,
  };
}

/** Apply one limit, deadline and cleanup path to HTTP and WebSocket work. */
async function run<T>(
  state: ReturnType<typeof initialize>,
  timeoutMs: number,
  requestSignal: AbortSignal | undefined,
  execute: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (state.disposed) {
    throw new BunawayError({
      code: "CANCELLED",
      message: "Network adapter is disposed.",
    });
  }
  if (state.active.size >= MAX_ACTIVE_REQUESTS) {
    throw new BunawayError({
      code: "BUSY",
      message: "Too many network requests.",
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
          message: "Network request timed out.",
        }),
      ),
    timeoutMs,
  );
  const task = execute(signal);
  state.active.set(controller, task);
  try {
    return await task;
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
    state.active.delete(controller);
  }
}

export function runRequest(
  state: ReturnType<typeof initialize>,
  input: RequestInput,
  signal?: AbortSignal,
) {
  return run(state, input.timeoutMs, signal, (activeSignal) =>
    request(input, activeSignal),
  );
}

export function runExchange(
  state: ReturnType<typeof initialize>,
  input: ExchangeInput,
  signal?: AbortSignal,
) {
  return run(state, input.timeoutMs, signal, (activeSignal) =>
    exchange(input, activeSignal),
  );
}

/** Cancel and drain all in-flight work; repeated cleanup is safe. */
export async function dispose(state: ReturnType<typeof initialize>) {
  if (!state.disposed) {
    state.disposed = true;
    for (const controller of state.active.keys()) {
      controller.abort(
        new BunawayError({
          code: "CANCELLED",
          message: "Network adapter is disposed.",
        }),
      );
    }
  }
  await Promise.allSettled(state.active.values());
}
