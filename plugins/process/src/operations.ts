import { defineNativeOperation } from "@bunaway/plugin";
import { processInputSchema, processResultSchema } from "#process/contract";
import { type initialize, run } from "#process/platforms/windows";

const operation = defineNativeOperation<ReturnType<typeof initialize>>();
/** One bounded Windows process invocation without a shell or persistent handle. */
export const processOperations = {
  run: operation({
    input: processInputSchema,
    output: processResultSchema,
    handler: (input, { instance, signal }) => run(instance, input, signal),
  }),
};
