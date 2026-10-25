import {
  base64CharactersFor,
  canonicalBase64Bytes,
  base64Schema as sharedBase64Schema,
} from "@bunaway/plugin";
import { isWindowsFileName } from "@bunaway/protocol";
import { z } from "zod";
export const MAX_IMAGE_BYTES = 524_288;
/** Largest width or height of an image, also the largest crop origin coordinate. */
export const MAX_IMAGE_DIMENSION = 4096;
export const MAX_ENCODED_BYTES = 600_000;
export const MAX_RESOURCES = 64;
export const MAX_POOL_BYTES = 8_388_608;
/** Largest scale factor of a representation or a selection request. */
export const MAX_SCALE_FACTOR = 4;
/** Representations one resource can hold besides its base pixels (scale factor 1). */
export const MAX_REPRESENTATIONS = 8;
/** Canonical base64 with bounded decoded length, including unused padding bits. */
function base64Schema(maxBytes: number) {
  return sharedBase64Schema(maxBytes, "Invalid canonical base64 data.");
}
export const rgbaSchema = z
  .strictObject({
    width: z.number().int().min(0).max(MAX_IMAGE_DIMENSION),
    height: z.number().int().min(0).max(MAX_IMAGE_DIMENSION),
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
/** Finite scale factor greater than 0 and at most {@link MAX_SCALE_FACTOR}. */
export const scaleFactorSchema = z.number().gt(0).max(MAX_SCALE_FACTOR);
/** Reference with an optional requested scale factor; omitted means 1. */
export const scaledReferenceSchema = z.strictObject({
  id: idSchema,
  scaleFactor: scaleFactorSchema.optional(),
});
export const addRepresentationSchema = z.strictObject({
  id: idSchema,
  scaleFactor: scaleFactorSchema.refine(
    (value) => value !== 1,
    "Scale factor 1 is the base image.",
  ),
  source: idSchema,
});
export const representationsSchema = z.strictObject({
  representations: z
    .array(
      z.strictObject({
        scaleFactor: scaleFactorSchema,
        width: z.number().int().min(1).max(MAX_IMAGE_DIMENSION),
        height: z.number().int().min(1).max(MAX_IMAGE_DIMENSION),
      }),
    )
    .max(MAX_REPRESENTATIONS + 1),
});
export const infoSchema = z
  .strictObject({
    width: z.number().int().min(0).max(MAX_IMAGE_DIMENSION),
    height: z.number().int().min(0).max(MAX_IMAGE_DIMENSION),
    empty: z.boolean(),
  })
  .refine(
    (value) =>
      (value.width === 0) === (value.height === 0) &&
      value.width * value.height * 4 <= MAX_IMAGE_BYTES &&
      value.empty === (value.width === 0),
    "Image metadata must match bounded dimensions and empty state.",
  );
/** Info of the representation chosen for a requested scale factor, with the factor actually chosen. */
export const selectedInfoSchema = infoSchema.safeExtend({
  scaleFactor: scaleFactorSchema,
});
/** `getInfo` answers with `scaleFactor` only when the request named one. */
export const getInfoResultSchema = z.union([
  infoSchema,
  selectedInfoSchema,
]);
export const resourceSchema = infoSchema.safeExtend({
  id: idSchema,
});
export const exportSchema = z.strictObject({
  id: idSchema,
  format: mimeSchema,
  scaleFactor: scaleFactorSchema.optional(),
});
export const interpolationSchema = z.enum([
  "nearest",
  "linear",
]);
export type ImageInterpolation = z.infer<typeof interpolationSchema>;
const transformSizeSchema = z
  .strictObject({
    width: z.number().int().min(1).max(MAX_IMAGE_DIMENSION),
    height: z.number().int().min(1).max(MAX_IMAGE_DIMENSION),
  })
  .refine(
    (value) => value.width * value.height * 4 <= MAX_IMAGE_BYTES,
    "Transform output exceeds the pixel limit.",
  );
export const cropSchema = transformSizeSchema.safeExtend({
  id: idSchema,
  x: z.number().int().min(0).max(MAX_IMAGE_DIMENSION),
  y: z.number().int().min(0).max(MAX_IMAGE_DIMENSION),
});
export const resizeSchema = transformSizeSchema.safeExtend({
  id: idSchema,
  interpolation: interpolationSchema.optional(),
});
/** Largest image file `createFromPath` reads; the size is checked on the opened file before any byte is read. */
export const MAX_SOURCE_FILE_BYTES = 16_777_216;
/** Largest width or height of an image file `createFromPath` decodes, checked from the header before pixel decoding. */
export const MAX_SOURCE_DIMENSION = 16_384;
/** Largest pixel count of an image file `createFromPath` decodes. */
export const MAX_SOURCE_PIXELS = 64_000_000;
/** Longest drive path `createFromPath` accepts, the Win32 `MAX_PATH` limit without the terminating NUL. */
export const MAX_SOURCE_PATH_LENGTH = 259;
/**
 * Absolute local drive path of a PNG, JPEG or BMP file. UNC paths, device namespaces and
 * alternate data streams are rejected, as are `.` and `..` parts and reserved device names. The
 * check is syntactic: a mapped network drive or a link can still lead to a network share, which
 * the app decides to allow or not.
 */
export const imagePathSchema = z
  .string()
  .max(MAX_SOURCE_PATH_LENGTH)
  .regex(/^[A-Za-z]:[\\/]/, "Path must be an absolute local drive path.")
  .refine(
    (path) =>
      path
        .slice(3)
        .split(/[\\/]/)
        .every((name) => isWindowsFileName(name)),
    "Path must contain only valid Windows file names.",
  );
/** `maxDimension` bounds the longer edge of the result; the image is never enlarged. */
export const createFromPathSchema = z.strictObject({
  path: imagePathSchema,
  maxDimension: z.number().int().min(1).max(MAX_IMAGE_DIMENSION).optional(),
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
