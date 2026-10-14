import { defineNativeOperation } from "@bunaway/plugin";
import {
  exchangeInputSchema,
  exchangeResultSchema,
  requestInputSchema,
  responseSchema,
} from "./contract.ts";
import {
  type initialize as initializeMacos,
  runExchange as runMacosExchange,
  runRequest as runMacosRequest,
} from "./platforms/macos.ts";
import {
  type initialize as initializeWindows,
  runExchange as runWindowsExchange,
  runRequest as runWindowsRequest,
} from "./platforms/windows.ts";

const macosOperation =
  defineNativeOperation<ReturnType<typeof initializeMacos>>();
const windowsOperation =
  defineNativeOperation<ReturnType<typeof initializeWindows>>();
/** Each platform dispatches bounded network work through its native build boundary. */
export const macosOperations = {
  request: macosOperation({
    input: requestInputSchema,
    output: responseSchema,
    handler: (input, { instance, signal }) =>
      runMacosRequest(instance, input, signal),
  }),
  exchange: macosOperation({
    input: exchangeInputSchema,
    output: exchangeResultSchema,
    handler: (input, { instance, signal }) =>
      runMacosExchange(instance, input, signal),
  }),
};
export const windowsOperations = {
  request: windowsOperation({
    input: requestInputSchema,
    output: responseSchema,
    handler: (input, { instance, signal }) =>
      runWindowsRequest(instance, input, signal),
  }),
  exchange: windowsOperation({
    input: exchangeInputSchema,
    output: exchangeResultSchema,
    handler: (input, { instance, signal }) =>
      runWindowsExchange(instance, input, signal),
  }),
};
