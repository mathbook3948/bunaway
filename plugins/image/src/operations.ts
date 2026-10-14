import { defineNativeOperation } from "@bunaway/plugin";
import { BunawayError, type JsonValue, validateValue } from "@bunaway/protocol";
import { z } from "zod";
import {
  bytesSchema,
  cropSchema,
  dataURLSchema,
  exportSchema,
  infoSchema,
  referenceSchema,
  resizeSchema,
  resourceSchema,
  rgbaSchema,
} from "./contract.ts";
import type { ImagePlatform } from "./image-platform.ts";

const operation = defineNativeOperation<ImagePlatform>();
/** Both codecs share complete image operations, including cancellation and app-owned resource lifetime. */
export const imageOperations = {
  createRGBA: operation({
    input: rgbaSchema,
    output: resourceSchema,
    handler: (input, { instance, signal }) =>
      instance.createRGBA(input, signal),
  }),
  createBytes: operation({
    input: bytesSchema,
    output: resourceSchema,
    handler: (input, { instance, signal }) =>
      instance.createBytes(input, signal),
  }),
  createDataURL: operation({
    input: z.strictObject({
      url: dataURLSchema,
    }),
    output: resourceSchema,
    handler: ({ url }, { instance, signal }) =>
      instance.createDataURL(url, signal),
  }),
  getInfo: operation({
    input: referenceSchema,
    output: infoSchema,
    handler: ({ id }, { instance }) => instance.getInfo(id),
  }),
  getPixels: operation({
    input: referenceSchema,
    output: rgbaSchema,
    handler: ({ id }, { instance }) => instance.getPixels(id),
  }),
  exportBytes: operation({
    input: exportSchema,
    output: bytesSchema,
    handler: (input, { instance }) => instance.exportBytes(input),
  }),
  exportDataURL: operation({
    input: exportSchema,
    output: dataURLSchema,
    handler: (input, { instance }) => instance.exportDataURL(input),
  }),
  dispose: operation({
    input: referenceSchema,
    output: z.boolean(),
    handler: ({ id }, { instance }) => instance.remove(id),
  }),
  crop: operation({
    input: cropSchema,
    output: resourceSchema,
    handler: (input, { instance, signal }) => instance.crop(input, signal),
  }),
  resize: operation({
    input: resizeSchema,
    output: resourceSchema,
    handler: (input, { instance, signal }) => instance.resize(input, signal),
  }),
};

/** Reject unknown operations and detach JSON inputs before native resources are acquired. */
export function validateImageInput(operation: string, input: JsonValue) {
  const name = operation.slice("image.".length);
  if (
    !operation.startsWith("image.") ||
    !Object.hasOwn(imageOperations, name)
  ) {
    throw new BunawayError({
      code: "UNSUPPORTED",
      message: "Image operation is not registered.",
    });
  }
  // Object.hasOwn restricts this dynamic operation key to the declared contract.
  const schema = imageOperations[name as keyof typeof imageOperations].input;
  try {
    return schema.parse(validateValue({}, input));
  } catch {
    throw new BunawayError({
      code: "INVALID_ARGUMENT",
      message: "Invalid image input.",
    });
  }
}
