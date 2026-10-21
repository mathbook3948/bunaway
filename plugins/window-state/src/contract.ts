import { int32Schema } from "@bunaway/plugin";
import { z } from "zod";

/** Name of the store that keeps every saved window state. */
export const WINDOW_STATE_STORE = "window-state";
/** Smallest piece of a saved window, in logical pixels, that must overlap a work area to keep its position. */
export const MIN_VISIBLE_LOGICAL_PIXELS = 48;
/** Reference DPI of a logical pixel. */
export const LOGICAL_DPI = 96;

/** Window name or custom key: the characters and length the window operations accept for a view name. */
export const stateKeySchema = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/u);

const coordinate = int32Schema;
const extent = int32Schema.min(1);

/**
 * One saved window as it sits in the store. Bounds are the physical outer rectangle the window
 * returns to when it is not maximized or fullscreen; `dpi` is the DPI of the window when saved.
 * The store is a file an app or user can edit, so every read goes through this schema.
 */
export const savedWindowStateSchema = z.strictObject({
  version: z.literal(1),
  x: coordinate,
  y: coordinate,
  width: extent,
  height: extent,
  dpi: z.int().min(1).max(65535),
  maximized: z.boolean(),
  fullscreen: z.boolean(),
  visible: z.boolean(),
});
export type SavedWindowState = z.infer<typeof savedWindowStateSchema>;

const target = {
  view: stateKeySchema,
  windowId: stateKeySchema.exactOptional(),
  key: stateKeySchema.exactOptional(),
};

export const saveInputSchema = z.strictObject(target);
export type WindowStateSaveInput = z.infer<typeof saveInputSchema>;

export const restoreIncludeSchema = z.strictObject({
  position: z.boolean().exactOptional(),
  size: z.boolean().exactOptional(),
  maximized: z.boolean().exactOptional(),
  fullscreen: z.boolean().exactOptional(),
  visible: z.boolean().exactOptional(),
});
/** Fields `restore` applies; `visible` is off unless asked for. */
export type WindowStateInclude = z.infer<typeof restoreIncludeSchema>;

export const restoreInputSchema = z.strictObject({
  ...target,
  include: restoreIncludeSchema.exactOptional(),
});
export type WindowStateRestoreInput = z.infer<typeof restoreInputSchema>;

export const removeInputSchema = z
  .strictObject({
    view: stateKeySchema.exactOptional(),
    key: stateKeySchema.exactOptional(),
  })
  .refine((input) => input.view !== undefined || input.key !== undefined, {
    message: "Pass view or key.",
  });
export type WindowStateRemoveInput = z.infer<typeof removeInputSchema>;

/** Result of `windowState.restore`. */
export type WindowStateRestoreResult = {
  /** A valid saved state existed and was applied. */
  restored: boolean;
  /** The saved rectangle was moved or resized to fit the current monitors. */
  adjusted: boolean;
};
