import { z } from "zod";

/** Bound the serialized result as well as each native string. */
export const MAX_DIALOG_PATHS = 128;
export const MAX_DIALOG_PATH_UNITS = 32767;
export const MAX_DIALOG_RESULT_UNITS = 131072;
const text = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(/^[^\0]+$/u);
const extension = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/);
const base = {
  ownerWindowId: text(128).optional(),
  title: text(256).optional(),
  defaultDirectory: text(MAX_DIALOG_PATH_UNITS).optional(),
};
const file = {
  ...base,
  filters: z
    .array(
      z.strictObject({
        name: text(128),
        extensions: z
          .array(
            z.union([
              extension,
              z.literal("*"),
            ]),
          )
          .min(1)
          .max(32),
      }),
    )
    .min(1)
    .max(32)
    .optional(),
  defaultFileName: text(255)
    .regex(/^[^<>:"/\\|?*]+$/u)
    .optional(),
  defaultExtension: extension.optional(),
};
export const openFileSchema = z.strictObject({
  ...file,
  multiple: z.boolean().optional(),
});
export const selectFolderSchema = z.strictObject({
  ...base,
  multiple: z.boolean().optional(),
});
export const saveFileSchema = z.strictObject(file);
export const resultSchema = z.discriminatedUnion("cancelled", [
  z.strictObject({
    cancelled: z.literal(true),
  }),
  z.strictObject({
    cancelled: z.literal(false),
    paths: z.array(text(MAX_DIALOG_PATH_UNITS)).min(1).max(MAX_DIALOG_PATHS),
  }),
]);
export type DialogInput = z.output<typeof openFileSchema>;
export type DialogResult = z.output<typeof resultSchema>;
export type DialogKind = "openFile" | "selectFolder" | "saveFile";
