import {
  base64CharactersFor,
  canonicalBase64Bytes,
  base64Schema as sharedBase64Schema,
} from "@bunaway/plugin";
import { z } from "zod";
export const MAX_IMAGE_BYTES = 524_288;
export const MAX_ENCODED_BYTES = 600_000;
export const MAX_RESOURCES = 64;
export const MAX_POOL_BYTES = 8_388_608;
/** Canonical base64 with bounded decoded length, including unused padding bits. */
function base64Schema(maxBytes: number) {
  return sharedBase64Schema(maxBytes, "Invalid canonical base64 data.");
}
export const rgbaSchema = z
  .strictObject({
    width: z.number().int().min(0).max(4096),
    height: z.number().int().min(0).max(4096),
    rgba: base64Schema(MAX_IMAGE_BYTES),
  })
  .refine((value) => {
    const pixelBytes = value.width * value.height * 4;
    return (
      (value.width === 0) === (value.height === 0) &&
      pixelBytes <= MAX_IMAGE_BYTES &&
      canonicalBase64Bytes(value.rgba) === pixelBytes
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
  .max(base64CharactersFor(MAX_ENCODED_BYTES) + 32)
  .regex(/^data:image\/(?:png|jpeg|bmp);base64,[A-Za-z0-9+/=]+$(?![\s\S])/)
  .refine(
    (url) =>
      bytesSchema.safeParse({
        mime: url.slice(5, url.indexOf(";")),
        data: url.slice(url.indexOf(",") + 1),
      }).success,
    "Data URL must contain canonical bounded base64 image bytes.",
  );
export const idSchema = z.string().uuid();
export const referenceSchema = z.strictObject({
  id: idSchema,
});
export const infoSchema = z
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
export const resourceSchema = infoSchema.safeExtend({
  id: idSchema,
});
export const exportSchema = z.strictObject({
  id: idSchema,
  format: mimeSchema,
});
export const interpolationSchema = z.enum([
  "nearest",
  "linear",
]);
export type ImageInterpolation = z.infer<typeof interpolationSchema>;
const transformSizeSchema = z
  .strictObject({
    width: z.number().int().min(1).max(4096),
    height: z.number().int().min(1).max(4096),
  })
  .refine(
    (value) => value.width * value.height * 4 <= MAX_IMAGE_BYTES,
    "Transform output exceeds the pixel limit.",
  );
export const cropSchema = transformSizeSchema.safeExtend({
  id: idSchema,
  x: z.number().int().min(0).max(4096),
  y: z.number().int().min(0).max(4096),
});
export const resizeSchema = transformSizeSchema.safeExtend({
  id: idSchema,
  interpolation: interpolationSchema.optional(),
});
/** Pixel edge length of each file type icon size, matching the shell small, large and extra-large icon lists. */
export const FILE_TYPE_ICON_PIXELS = {
  small: 16,
  normal: 32,
  large: 48,
} as const;
export type FileTypeIconSize = keyof typeof FILE_TYPE_ICON_PIXELS;
/**
 * A dot followed by 1 to 31 letters, digits, `_`, `-`, `+` or `~`. Path separators, NUL, whitespace,
 * `:` and further dots are excluded, so the value can only be an extension and never a file path.
 */
export const fileExtensionSchema = z
  .string()
  .regex(/^\.[A-Za-z0-9_+~-]{1,31}$(?![\s\S])/);
export const fileTypeIconSchema = z.strictObject({
  extension: fileExtensionSchema,
  size: z.enum([
    "small",
    "normal",
    "large",
  ]),
});
