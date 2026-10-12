import { BunawayError, type JsonValue, validateValue } from "@bunaway/protocol";
import { z } from "zod";

export const MAX_IMAGE_BYTES = 524_288;
export const MAX_ENCODED_BYTES = 600_000;
export const MAX_RESOURCES = 64;
export const MAX_POOL_BYTES = 8_388_608;
const alphabet =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
/** Canonical base64 with bounded decoded length, including unused padding bits. */
function base64Schema(maxBytes: number) {
  return z
    .string()
    .max(Math.ceil(maxBytes / 3) * 4)
    .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)
    .refine((value) => {
      let padding = 0;
      if (value.endsWith("==")) {
        padding = 2;
      } else if (value.endsWith("=")) {
        padding = 1;
      }
      const last = alphabet.indexOf(value[value.length - padding - 1] ?? "");
      return (
        (value.length / 4) * 3 - padding <= maxBytes &&
        (padding === 0 || (last & (padding === 2 ? 15 : 3)) === 0)
      );
    }, "Invalid canonical base64 data.");
}
export const rgbaSchema = z
  .strictObject({
    width: z.number().int().min(0).max(4096),
    height: z.number().int().min(0).max(4096),
    rgba: base64Schema(MAX_IMAGE_BYTES),
  })
  .refine((value) => {
    let padding = 0;
    if (value.rgba.endsWith("==")) {
      padding = 2;
    } else if (value.rgba.endsWith("=")) {
      padding = 1;
    }
    return (
      (value.width === 0) === (value.height === 0) &&
      value.width * value.height * 4 <= MAX_IMAGE_BYTES &&
      (value.rgba.length / 4) * 3 - padding === value.width * value.height * 4
    );
  }, "Dimensions must match RGBA bytes; only 0 by 0 is empty.");
export const mimeSchema = z.enum([
  "image/png",
  "image/jpeg",
  "image/bmp",
]);
export type ImageMime = z.infer<typeof mimeSchema>;
export const bytesSchema = z.strictObject({
  mime: mimeSchema,
  data: base64Schema(MAX_ENCODED_BYTES).min(4),
});
export const dataURLSchema = z
  .string()
  .max(Math.ceil(MAX_ENCODED_BYTES / 3) * 4 + 32)
  .regex(/^data:image\/(?:png|jpeg|bmp);base64,[A-Za-z0-9+/=]+$/)
  .refine(
    (url) =>
      bytesSchema.safeParse({
        mime: url.slice(5, url.indexOf(";")),
        data: url.slice(url.indexOf(",") + 1),
      }).success,
    "Data URL must contain canonical bounded base64 image bytes.",
  );
export const idSchema = z.string().uuid();
const referenceSchema = z.strictObject({
  id: idSchema,
});
const infoSchema = z
  .strictObject({
    width: z.number().int().min(0).max(4096),
    height: z.number().int().min(0).max(4096),
    empty: z.boolean(),
  })
  .refine(
    (value) =>
      (value.width === 0) === (value.height === 0) &&
      value.width * value.height * 4 <= MAX_IMAGE_BYTES &&
      value.empty === (value.width === 0),
    "Image metadata must match bounded dimensions and empty state.",
  );
const resourceSchema = infoSchema.safeExtend({
  id: idSchema,
});
const exportSchema = z.strictObject({
  id: idSchema,
  format: mimeSchema,
});
/** App-owned resource IDs require the corresponding operation permission on every call. */
export const imageOperations = {
  createRGBA: {
    input: rgbaSchema,
    output: resourceSchema,
  },
  createBytes: {
    input: bytesSchema,
    output: resourceSchema,
  },
  createDataURL: {
    input: z.strictObject({
      url: dataURLSchema,
    }),
    output: resourceSchema,
  },
  getInfo: {
    input: referenceSchema,
    output: infoSchema,
  },
  getPixels: {
    input: referenceSchema,
    output: rgbaSchema,
  },
  exportBytes: {
    input: exportSchema,
    output: bytesSchema,
  },
  exportDataURL: {
    input: exportSchema,
    output: dataURLSchema,
  },
  dispose: {
    input: referenceSchema,
    output: z.boolean(),
  },
} as const;

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
