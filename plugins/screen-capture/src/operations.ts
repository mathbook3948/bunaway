import { BunawayError, defineNativeOperation } from "@bunaway/plugin";
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
    handler(input, { instance, permissions, signal }) {
      // Thumbnails are captures, so a listing that asks for them needs the capture permission too.
      // `permissions` is absent only on direct adapter calls, which carry no host authority to check.
      if (
        input.thumbnailSize !== undefined &&
        permissions !== undefined &&
        !permissions.permissions.includes("screenCapture.captureSource")
      ) {
        throw new BunawayError({
          code: "PERMISSION_DENIED",
          message: "Plugin permission denied.",
        });
      }
      return instance.listSources(input, signal);
    },
  }),
  captureSource: operation({
    input: captureInputSchema,
    output: captureOutputSchema,
    handler: (input, { instance }) => instance.captureSource(input),
  }),
};
