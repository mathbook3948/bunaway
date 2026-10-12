import { MAX_WINDOW_COORDINATE, MIN_WINDOW_COORDINATE } from "@bunaway/plugin-api/native";
import { z } from "zod";

const coordinate = z.int().min(MIN_WINDOW_COORDINATE).max(MAX_WINDOW_COORDINATE);
export const monitorPointSchema = z.strictObject({ x: coordinate, y: coordinate });
export const monitorRectSchema = z.strictObject({
  ...monitorPointSchema.shape,
  width: z.int().positive().max(MAX_WINDOW_COORDINATE),
  height: z.int().positive().max(MAX_WINDOW_COORDINATE),
}).refine((rect) => rect.x + rect.width <= MAX_WINDOW_COORDINATE && rect.y + rect.height <= MAX_WINDOW_COORDINATE);
/** Physical virtual-screen bounds and work area, effective DPI and optional driver metrics. */
export const monitorSchema = z.strictObject({
  id: z.string().min(1).max(32),
  name: z.string().min(1).max(128),
  primary: z.boolean(),
  bounds: monitorRectSchema,
  workArea: monitorRectSchema,
  dpi: z.int().positive().max(65535),
  scaleFactor: z.number().positive().max(65535 / 96),
  rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270), z.null()]),
  refreshRate: z.union([z.int().min(2), z.null()]),
});
export type Monitor = z.output<typeof monitorSchema>;
