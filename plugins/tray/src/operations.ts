import { defineNativeOperation } from "@bunaway/plugin";
import { z } from "zod";
import {
  icoSchema,
  positionSchema,
  snapshotSchema,
  tooltipSchema,
  trayEventSchema,
} from "./contract.ts";
import {
  focus,
  get,
  getBounds,
  type initialize,
  setClickBehavior,
  setIcon,
  setTooltip,
  waitForEvent,
} from "./platforms/windows.ts";

const operation = defineNativeOperation<ReturnType<typeof initialize>>();
/** Controls and input waits for the app's configured Windows tray. */
export const trayOperations = {
  get: operation({
    input: z.null(),
    output: snapshotSchema.nullable(),
    handler: (_input, { instance }) => get(instance),
  }),
  getBounds: operation({
    input: z.null(),
    output: positionSchema
      .extend({
        width: z.number().int().min(0).max(2147483647),
        height: z.number().int().min(0).max(2147483647),
      })
      .nullable(),
    handler: (_input, { instance }) => getBounds(instance),
  }),
  setTooltip: operation({
    input: z.strictObject({
      tooltip: tooltipSchema,
    }),
    output: z.null(),
    handler: ({ tooltip }, { instance }) => setTooltip(instance, tooltip),
  }),
  setIcon: operation({
    input: z.strictObject({
      ico: icoSchema.nullable(),
    }),
    output: z.null(),
    handler: ({ ico }, { instance }) => setIcon(instance, ico),
  }),
  setClickBehavior: operation({
    input: z.strictObject({
      showOnLeftClick: z.boolean(),
      menuOnRightClick: z.boolean(),
    }),
    output: z.null(),
    handler: ({ showOnLeftClick, menuOnRightClick }, { instance }) =>
      setClickBehavior(instance, showOnLeftClick, menuOnRightClick),
  }),
  focus: operation({
    input: z.null(),
    output: z.boolean(),
    handler: (_input, { instance }) => focus(instance),
  }),
  waitForEvent: operation({
    input: z.null(),
    output: trayEventSchema,
    handler: (_input, { instance, signal }) => waitForEvent(instance, signal),
  }),
};
