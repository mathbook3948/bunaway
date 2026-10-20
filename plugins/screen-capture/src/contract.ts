import { base64Schema, int32Schema } from "@bunaway/plugin";
import { z } from "zod";

/** Most sources one screenCapture.listSources call returns; a larger list is an error, not a shortened one. */
export const MAX_SOURCES = 256;
/** Longest source name in UTF-16 code units; a longer window title is cut, not rejected. */
export const MAX_SOURCE_NAME_CHARS = 256;
/** Size of the box a capture is fitted into when the caller gives none (Electron's default `thumbnailSize`). */
export const DEFAULT_CAPTURE_EDGE_PIXELS = 150;
/** Largest width or height of a captured image, the same limit as the image plugin. */
export const MAX_CAPTURE_EDGE_PIXELS = 4096;
/** Largest PNG one capture returns: 640 KiB keeps its base64 text inside the 1 MiB message limit. */
export const MAX_CAPTURE_PNG_BYTES = 655_360;
/** Largest window rectangle (8K) a capture allocates a device-independent bitmap for. */
export const MAX_SOURCE_PIXELS = 7680 * 4320;

export const sourceKindSchema = z.enum([
  "screen",
  "window",
]);
/** What a source is: a monitor or a top-level window. */
export type ScreenCaptureSourceKind = z.infer<typeof sourceKindSchema>;

export const listSourcesInputSchema = z.strictObject({
  types: z
    .array(sourceKindSchema)
    .min(1)
    .max(sourceKindSchema.options.length)
    .refine((types) => new Set(types).size === types.length, {
      message: "Source types must not repeat.",
    }),
});
/** Input of screenCapture.listSources: the kinds of source to list. */
export type ScreenCaptureListInput = z.infer<typeof listSourcesInputSchema>;

/** Physical pixels in virtual-screen coordinates. */
export const boundsSchema = z.strictObject({
  x: int32Schema,
  y: int32Schema,
  width: int32Schema.min(0),
  height: int32Schema.min(0),
});
export const sourceSchema = z.strictObject({
  id: z.uuid(),
  kind: sourceKindSchema,
  name: z.string().max(MAX_SOURCE_NAME_CHARS),
  bounds: boundsSchema,
  ownedByApp: z.boolean(),
  minimized: z.boolean(),
  monitorId: z.string().min(1).max(MAX_SOURCE_NAME_CHARS).optional(),
});
/** One capturable monitor or window. `id` stays valid until a later listing no longer contains the source. */
export type ScreenCaptureSource = z.infer<typeof sourceSchema>;
export const sourceListSchema = z.array(sourceSchema).max(MAX_SOURCES);

const edgeSchema = z.number().int().min(1).max(MAX_CAPTURE_EDGE_PIXELS);
export const captureInputSchema = z.strictObject({
  id: z.uuid(),
  maxWidth: edgeSchema.optional(),
  maxHeight: edgeSchema.optional(),
});
/** Input of screenCapture.captureSource; the image is fitted into `maxWidth` by `maxHeight` without enlarging. */
export type ScreenCaptureInput = z.infer<typeof captureInputSchema>;

export const captureOutputSchema = z.strictObject({
  mime: z.literal("image/png"),
  data: base64Schema(MAX_CAPTURE_PNG_BYTES),
  width: edgeSchema,
  height: edgeSchema,
});
/** A captured source as a PNG, in physical pixels. */
export type ScreenCaptureImage = z.infer<typeof captureOutputSchema>;

/** What every platform adapter provides; operations are typed by this interface, not by a platform module. */
export interface ScreenCaptureInstance {
  listSources(input: ScreenCaptureListInput): ScreenCaptureSource[];
  captureSource(input: ScreenCaptureInput): ScreenCaptureImage;
}
