import { defineNativeAdapter, type NativeHandlers } from "@bunaway/plugin";
import { z } from "zod";

/** Compile-time checks of parsed inputs, output contracts, state and allowed operation keys. */
export function nativeHandlerTypes() {
  const schemas = {
    length: {
      input: z.string().transform((value) => value.length),
      output: z.number(),
    },
  };
  const valid = defineNativeAdapter(schemas, {
    setup: () => ({
      offset: 1,
    }),
    handlers: {
      length(input, context, state) {
        const parsed: number = input;
        const source: string = context.source;
        const offset: number = state.offset;
        // @ts-expect-error Handler input is the parsed schema output, not the caller's string.
        const raw: string = input;
        // @ts-expect-error Authorization is SDK-owned and is not a plugin authoring step.
        context.beforeExecute();
        return parsed + offset + source.length + raw.length;
      },
    },
    dispose() {},
  });
  const wrongInput: NativeHandlers<typeof schemas, null> = {
    // @ts-expect-error Schema transforms determine the handler parameter type.
    length: (input: string) => input.length,
  };
  const wrongOutput: NativeHandlers<typeof schemas, null> = {
    // @ts-expect-error Handler results must match the declared output schema.
    length: () => "bad",
  };
  const wrongKey: NativeHandlers<typeof schemas, null> = {
    // @ts-expect-error Undeclared operation keys cannot claim platform support.
    unknown: () => 0,
  };
  return {
    valid,
    wrongInput,
    wrongOutput,
    wrongKey,
  };
}
