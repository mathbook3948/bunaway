import { defineNativeOperation } from "@bunaway/plugin";
import {
  macosProcessInputSchema,
  type ProcessInstance,
  processInputSchema,
  processResultSchema,
} from "#process/contract";
import { run as runMacos } from "#process/platforms/macos";
import { run } from "#process/platforms/windows";

const operation = defineNativeOperation<ProcessInstance>();
const macosOperation = defineNativeOperation<ProcessInstance>();
/** One bounded Windows process invocation without a shell or persistent handle. */
export const processOperations = {
  run: operation({
    input: processInputSchema,
    output: processResultSchema,
    handler: (input, { instance, signal }) => run(instance, input, signal),
  }),
};
/** The same invocation on macOS; only the executable path rules differ. */
export const macosProcessOperations = {
  run: macosOperation({
    input: macosProcessInputSchema,
    output: processResultSchema,
    handler: (input, { instance, signal }) => runMacos(instance, input, signal),
  }),
};
