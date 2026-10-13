import { BunawayError, type JsonValue } from "@bunaway/protocol";
import type { z } from "zod";
import type {
  NativeAdapter,
  NativeAdapterFactory,
  NativeEnvironment,
  NativeOperationDefinition,
} from "./index.ts";

/** Live authority and cancellation supplied by the host immediately before execution. */
export type NativeCallContext = Pick<
  Parameters<NonNullable<NativeAdapter["executeUI"]>>[3],
  "requestId" | "permissions" | "signal"
> & {
  source: string;
};
/** Parsed operation inputs and raw outputs, inferred from the plugin's schemas. */
export type NativeHandlers<
  O extends Record<string, NativeOperationDefinition>,
  State,
> = {
  readonly [K in keyof O]?: (
    input: z.output<O[K]["input"]>,
    context: NativeCallContext,
    state: State,
  ) => z.input<O[K]["output"]> | Promise<z.input<O[K]["output"]>>;
};
/** Factory with platform support inferred from its immutable handler keys. */
export type NativeHandlerFactory = NativeAdapterFactory & {
  readonly operations: readonly string[];
};

/**
 * Declare a platform's functions once. Handler keys supply capability support;
 * setup owns shared resources, and dispose releases them, including after partial host startup.
 * The enclosing defineNativePlugin parses schemas and rechecks live authority before entry.
 */
export function defineNativeAdapter<
  const O extends Record<string, NativeOperationDefinition>,
  State,
>(
  operations: O,
  implementation: {
    setup(environment: NativeEnvironment): State;
    handlers: NativeHandlers<O, State>;
    busy?(state: State): boolean;
    dispose(state: State): void | Promise<void>;
  },
): NativeHandlerFactory {
  const handlers = new Map(Object.entries(implementation.handlers));
  for (const [name, handler] of handlers) {
    if (!Object.hasOwn(operations, name) || typeof handler !== "function") {
      throw new Error("Invalid native operation handler.");
    }
  }
  const create: NativeAdapterFactory = (environment) => {
    const state = implementation.setup(environment);
    return {
      execute() {
        throw new BunawayError({
          code: "UNSUPPORTED",
          message: "Native handlers require a host call context.",
        });
      },
      executeUI(operation, input, source, context) {
        const name = operation.slice(operation.indexOf(".") + 1);
        const handler = handlers.get(name);
        if (!handler) {
          throw new BunawayError({
            code: "UNSUPPORTED",
            message: "Plugin operation is not implemented.",
          });
        }
        if (!context.permissions.permissions.includes(operation)) {
          throw new BunawayError({
            code: "PERMISSION_DENIED",
            message: "Plugin permission denied.",
          });
        }
        // Dynamic dispatch is the only erased type boundary. The SDK has parsed this key's schema.
        return (
          handler as (
            input: JsonValue,
            context: NativeCallContext,
            state: State,
          ) => JsonValue | Promise<JsonValue>
        )(
          input,
          {
            ...context,
            source,
          },
          state,
        );
      },
      ...(implementation.busy
        ? {
            busy: () => implementation.busy?.(state) ?? false,
          }
        : {}),
      dispose: () => implementation.dispose(state),
    };
  };
  return Object.freeze(
    Object.assign(create, {
      operations: Object.freeze([
        ...handlers.keys(),
      ]),
    }),
  );
}
