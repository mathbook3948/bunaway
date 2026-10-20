import { defineNativeOperation } from "@bunaway/plugin";
import {
  captureInputSchema,
  captureOutputSchema,
  listSourcesInputSchema,
  type ScreenCaptureInstance,
  sourceListSchema,
} from "#screen-capture/contract";

const operation = defineNativeOperation<ScreenCaptureInstance>();
/** Each operation requires its own permission, named after the operation. */
export const screenCaptureOperations = {
  listSources: operation({
    input: listSourcesInputSchema,
    output: sourceListSchema,
    handler: (input, { instance }) => instance.listSources(input),
  }),
  captureSource: operation({
    input: captureInputSchema,
    output: captureOutputSchema,
    handler: (input, { instance }) => instance.captureSource(input),
  }),
};
