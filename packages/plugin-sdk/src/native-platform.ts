import { BunawayError, type JsonValue } from "@bunaway/protocol";

import type {
  NativeAdapter,
  NativeAdapterFactory,
  NativeEnvironment,
  NativeOperationDefinition,
} from "./index.ts";

/** Host-selected call information and the instance owned by this execution thread. */
export type NativeHandlerContext<Instance = unknown> = {
  instance: Instance;
  source: string;
  /** Present on contextual host execution, absent on direct adapter calls. */
  requestId?: string;
  permissions?: import("@bunaway/protocol").Policy["backend"];
  signal?: AbortSignal;
};

/** Instance lifecycle on one host execution thread; imports never allocate OS resources. */
export type NativePlatformDefinition = {
  /** Owning thread for initialization, handlers and cleanup. Defaults to worker. */
  readonly thread?: "worker" | "ui";
  /** Must return synchronously; asynchronous initialization is rejected during activation. */
  readonly initialize?: (environment: NativeEnvironment) => unknown;
  /** Receives the initializer's value. Failed cleanup must remain safe to retry. */
  readonly dispose?: (instance: never) => void | Promise<void>;
  /** Report host work that must finish before the adapter can close. */
  readonly busy?: (instance: never) => boolean;
  /** This platform's complete operation declarations; keys determine support. */
  readonly operations: Readonly<
    Record<
      string,
      NativeOperationDefinition & {
        readonly handler: (
          input: never,
          context: NativeHandlerContext<never>,
        ) => unknown;
      }
    >
  >;
};

/** Internal erased signature; schema validation surrounds every invocation. */
export type NativeHandler = (
  input: JsonValue,
  context: NativeHandlerContext<unknown>,
) => JsonValue | Promise<JsonValue>;

/** Bridge one immutable handler inventory and lifecycle into the existing host dispatcher. */
export function handlerAdapterFactory(
  platform: NativePlatformDefinition,
  handlers: ReadonlyMap<string, NativeHandler>,
): NativeAdapterFactory {
  // The declaration checker derives the dispose parameter from the initializer's result.
  const dispose = platform.dispose as
    | ((instance: unknown) => void | Promise<void>)
    | undefined;
  const busy = platform.busy as ((instance: unknown) => boolean) | undefined;
  const initialize = platform.initialize;
  return (environment: NativeEnvironment): ReturnType<NativeAdapterFactory> => {
    const instance = initialize?.(environment);
    if (
      instance !== null &&
      (typeof instance === "object" || typeof instance === "function") &&
      "then" in instance &&
      typeof instance.then === "function"
    ) {
      // Invalid initializers may already be running; own their late resources and failures.
      void Promise.resolve(instance)
        .then((value) => dispose?.(value))
        .catch((error: unknown) => {
          console.error(
            "Asynchronous native plugin initialization or cleanup failed.",
            error,
          );
        });
      throw new Error("Native plugin initialize must return synchronously.");
    }
    let disposed = false;
    let disposal: Promise<void> | undefined;
    const invoke = (
      name: string,
      input: JsonValue,
      source: string,
      context?: Parameters<NonNullable<NativeAdapter["executeUI"]>>[3],
    ) => {
      if (disposed) {
        throw new BunawayError({
          code: "CANCELLED",
          message: "Plugin adapter is disposed.",
        });
      }
      const handler = handlers.get(name.slice(name.indexOf(".") + 1));
      if (!handler) {
        throw new BunawayError({
          code: "UNSUPPORTED",
          message: "Plugin operation is not supported on this platform.",
        });
      }
      context?.signal?.throwIfAborted();
      return handler(input, {
        instance,
        source,
        ...(context
          ? {
              requestId: context.requestId,
              permissions: context.permissions,
              ...(context.signal
                ? {
                    signal: context.signal,
                  }
                : {}),
            }
          : {}),
      });
    };
    // Keep the existing host dispatch boundary while authors provide only handlers.
    return {
      execute: invoke,
      executeUI: invoke,
      ...(busy
        ? {
            busy: () => busy(instance),
          }
        : {}),
      dispose() {
        disposed = true;
        if (!disposal) {
          // Declaration typing pairs disposal with this initializer's instance.
          disposal = Promise.resolve()
            .then(() => dispose?.(instance))
            .catch((error: unknown) => {
              disposal = undefined;
              throw error;
            });
        }
        return disposal;
      },
    };
  };
}
