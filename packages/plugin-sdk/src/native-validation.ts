import { BunawayError, type JsonValue, validateValue } from "@bunaway/protocol";
import type { z } from "zod";
import type { NativeAdapter, NativeOperationDefinition } from "./index.ts";

/** Parse once on the owning worker, preserving JSON limits before and after author code. */
function parse(schema: z.ZodType, value: unknown, output: boolean): JsonValue {
  try {
    return validateValue({}, schema.parse(validateValue({}, value)));
  } catch {
    throw new BunawayError({
      code: output ? "INTERNAL" : "INVALID_ARGUMENT",
      message: output ? "Invalid plugin output." : "Invalid plugin input.",
    });
  }
}

/** Wrap a platform adapter without changing its lifecycle, receiver or synchronous I/O contract. */
export function validatedAdapter(
  adapter: NativeAdapter,
  schemas: ReadonlyMap<string, NativeOperationDefinition>,
): NativeAdapter {
  const operation = (name: string) => {
    const schema = schemas.get(name);
    if (!schema) {
      throw new BunawayError({
        code: "UNSUPPORTED",
        message: "Plugin operation is not registered.",
      });
    }
    return schema;
  };
  const executeUI = adapter.executeUI?.bind(adapter);
  const busy = adapter.busy?.bind(adapter);
  return {
    execute(name, input, source) {
      const schema = operation(name);
      const result = adapter.execute(
        name,
        parse(schema.input, input, false),
        source,
      );
      return parse(schema.output, result, true);
    },
    ...(executeUI
      ? ({
          async executeUI(name, input, source, context) {
            const schema = operation(name);
            const result = await executeUI(
              name,
              parse(schema.input, input, false),
              source,
              context,
            );
            return parse(schema.output, result, true);
          },
        } satisfies Pick<NativeAdapter, "executeUI">)
      : {}),
    ...(busy
      ? {
          busy,
        }
      : {}),
    dispose: () => adapter.dispose(),
  };
}
