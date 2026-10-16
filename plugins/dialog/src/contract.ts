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
const owner = {
  ownerWindowId: text(128).optional(),
  title: text(256).optional(),
};
const base = {
  ...owner,
  defaultDirectory: text(MAX_DIALOG_PATH_UNITS).optional(),
  showHiddenFiles: z.boolean().optional(),
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
/**
 * File and folder dialog inputs.
 *
 * `showHiddenFiles` (all three dialogs): true forces hidden and system items to be listed. When
 * omitted or false, the user's Explorer setting decides. `confirmOverwrite` (`saveFile` only): true
 * or false forces the "replace existing file" prompt on or off. When omitted, the Windows default
 * prompt applies. Passing `confirmOverwrite` to `openFile` or `selectFolder` is rejected as
 * INVALID_ARGUMENT. The OS New Folder control cannot be disabled on Windows, so no option exists.
 */
export const openFileSchema = z.strictObject({
  ...file,
  multiple: z.boolean().optional(),
});
export const selectFolderSchema = z.strictObject({
  ...base,
  multiple: z.boolean().optional(),
});
export const saveFileSchema = z.strictObject({
  ...file,
  confirmOverwrite: z.boolean().optional(),
});
export const resultSchema = z.discriminatedUnion("cancelled", [
  z.strictObject({
    cancelled: z.literal(true),
  }),
  z.strictObject({
    cancelled: z.literal(false),
    paths: z.array(text(MAX_DIALOG_PATH_UNITS)).min(1).max(MAX_DIALOG_PATHS),
  }),
]);

/** Windows TaskDialog layout limits for message dialogs. Validated before any native allocation. */
export const MAX_DIALOG_BUTTONS = 8;
export const MAX_DIALOG_MESSAGE_UNITS = 4096;
export const MAX_DIALOG_DETAIL_UNITS = 8192;
export const MAX_DIALOG_BUTTON_LABEL_UNITS = 64;
export const MAX_DIALOG_CHECKBOX_LABEL_UNITS = 256;
const dialogTypes = z.enum([
  "none",
  "info",
  "warning",
  "error",
  "question",
]);
/**
 * Message dialog request.
 *
 * `message` is the main instruction and `detail` the secondary text. Omitting `buttons` shows one
 * OS-localized OK button (index 0). `defaultButton` (default 0) and `cancelButton` must index into
 * `buttons`. Cancel rule: an omitted `cancelButton` resolves to 0 when exactly one button exists
 * (Escape dismisses a single-button message) and otherwise stays undefined, which disables Escape and
 * the title-bar close button so the user must click a button. When defined, Escape, the title-bar
 * close button and Alt+F4 all return `cancelButton`.
 */
export const messageSchema = z
  .strictObject({
    ...owner,
    message: text(MAX_DIALOG_MESSAGE_UNITS),
    detail: text(MAX_DIALOG_DETAIL_UNITS).optional(),
    type: dialogTypes.optional(),
    buttons: z
      .array(text(MAX_DIALOG_BUTTON_LABEL_UNITS))
      .min(1)
      .max(MAX_DIALOG_BUTTONS)
      .optional(),
    defaultButton: z.number().int().min(0).optional(),
    cancelButton: z.number().int().min(0).optional(),
    checkbox: z
      .strictObject({
        label: text(MAX_DIALOG_CHECKBOX_LABEL_UNITS),
        checked: z.boolean().optional(),
      })
      .optional(),
  })
  .superRefine((value, context) => {
    const count = value.buttons?.length ?? 1;
    for (const field of [
      "defaultButton",
      "cancelButton",
    ] as const) {
      const index = value[field];
      if (index !== undefined && index >= count) {
        context.addIssue({
          code: "custom",
          message: `${field} must be less than the button count (${count}).`,
          path: [
            field,
          ],
        });
      }
    }
  });
/**
 * `button` is the clicked button index. `checkboxChecked` is always present and false when no
 * checkbox was requested. Host cancellation is a CANCELLED error, never a button result.
 */
export const messageResultSchema = z.strictObject({
  button: z
    .number()
    .int()
    .min(0)
    .max(MAX_DIALOG_BUTTONS - 1),
  checkboxChecked: z.boolean(),
});
export type MessageInput = z.output<typeof messageSchema>;
export type MessageResult = z.output<typeof messageResultSchema>;
/** Resolve the button that Escape and window close return, or undefined when closing is disabled. */
export function resolveCancelButton(
  buttonCount: number,
  cancelButton: number | undefined,
): number | undefined {
  return cancelButton ?? (buttonCount === 1 ? 0 : undefined);
}
/** Every file dialog field across the three inputs. All are optional, so each schema's output is assignable. */
export type DialogInput = z.output<typeof openFileSchema> &
  z.output<typeof saveFileSchema>;
export type DialogResult = z.output<typeof resultSchema>;
export type DialogKind = "openFile" | "selectFolder" | "saveFile";
