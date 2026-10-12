import { BunawayError, type JsonValue, validateValue } from "@bunaway/protocol";
import type { z } from "zod";
import type { NativeAdapter, NativeOperationDefinition } from "./index.ts";

/** SDK-owned adapter. Preparation parses input before the host grants synchronous I/O execution. */
export interface NativePluginAdapter extends Omit<NativeAdapter, "execute"> {
  /** Parse input once and return a one-shot execution that starts synchronously and awaits output parsing. */
  prepare(
    operation: string,
    input: JsonValue,
    source: string,
  ): Promise<() => Promise<JsonValue>>;
  /** Parse and execute when the caller does not need a separate authorization step. */
  execute(
    operation: string,
    input: JsonValue,
    source: string,
  ): Promise<JsonValue>;
}

/** Parse once on the owning worker and observe asynchronous callback failures. */
async function parse(
  schema: z.ZodType,
  value: unknown,
  output: boolean,
): Promise<JsonValue> {
  try {
    return validateValue({}, await schema.parseAsync(validateValue({}, value)));
  } catch {
    throw new BunawayError({
      code: output ? "INTERNAL" : "INVALID_ARGUMENT",
      message: output ? "Invalid plugin output." : "Invalid plugin input.",
    });
  }
}

/** Wrap a platform adapter without moving asynchronous parsing into the authorized native I/O step. */
export function validatedAdapter(
  adapter: NativeAdapter,
  schemas: ReadonlyMap<string, NativeOperationDefinition>,
): NativePluginAdapter {
  let disposed = false;
  const assertActive = () => {
    if (disposed) {
      throw new BunawayError({
        code: "CANCELLED",
        message: "Plugin adapter is disposed.",
      });
    }
  };
  const operation = (name: string) => {
    assertActive();
    const schema = schemas.get(name);
    if (!schema) {
      throw new BunawayError({
        code: "UNSUPPORTED",
        message: "Plugin operation is not registered.",
      });
    }
    return schema;
  };
  const prepare: NativePluginAdapter["prepare"] = async (
    name,
    input,
    source,
  ) => {
    const schema = operation(name);
    const parsed = await parse(schema.input, input, false);
    let executed = false;
    return async () => {
      assertActive();
      if (executed) {
        throw new Error("Prepared operation has already executed.");
      }
      executed = true;
      // No await before the native call: the host invokes this immediately on authorization.
      return parse(schema.output, adapter.execute(name, parsed, source), true);
    };
  };
  const executeUI = adapter.executeUI?.bind(adapter);
  const busy = adapter.busy?.bind(adapter);
  return {
    prepare,
    async execute(name, input, source) {
      const execute = await prepare(name, input, source);
      return execute();
    },
    ...(executeUI
      ? ({
          async executeUI(name, input, source, context) {
            const schema = operation(name);
            const parsed = await parse(schema.input, input, false);
            assertActive();
            context.signal?.throwIfAborted();
            context.beforeExecute?.();
            const result = await executeUI(name, parsed, source, context);
            return parse(schema.output, result, true);
          },
        } satisfies Pick<NativeAdapter, "executeUI">)
      : {}),
    ...(busy
      ? {
          busy,
        }
      : {}),
    dispose() {
      disposed = true;
      return adapter.dispose();
    },
  };
}
