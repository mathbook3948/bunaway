import { defineNativeOperation } from "@bunaway/plugin";
import { z } from "zod";
import {
  clickedSchema,
  idSchema,
  insertSchema,
  itemTargetSchema,
  MAX_MENU_RESOURCES,
  resourceSchema,
  targetSchema,
  updateItemSchema,
} from "./contract.ts";
import {
  create,
  get,
  getTrayMenu,
  type initialize,
  insert,
  list,
  remove,
  removeItem,
  replace,
  setTrayMenu,
  updateItem,
  waitForClick,
} from "./platforms/windows.ts";

const operation = defineNativeOperation<ReturnType<typeof initialize>>();
/** Windows menu resources, tray attachment and cancellable selection waits. */
export const menuOperations = {
  create: operation({
    input: resourceSchema,
    output: resourceSchema,
    handler: (input, { instance }) => create(instance, input),
  }),
  get: operation({
    input: targetSchema,
    output: resourceSchema.nullable(),
    handler: (input, { instance }) => get(instance, input),
  }),
  list: operation({
    input: z.null(),
    output: z.array(idSchema).max(MAX_MENU_RESOURCES),
    handler: (_input, { instance }) => list(instance),
  }),
  replace: operation({
    input: resourceSchema,
    output: resourceSchema,
    handler: (input, { instance }) => replace(instance, input),
  }),
  remove: operation({
    input: targetSchema,
    output: z.boolean(),
    handler: (input, { instance }) => remove(instance, input),
  }),
  insert: operation({
    input: insertSchema,
    output: resourceSchema,
    handler: (input, { instance }) => insert(instance, input),
  }),
  removeItem: operation({
    input: itemTargetSchema,
    output: resourceSchema,
    handler: (input, { instance }) => removeItem(instance, input),
  }),
  updateItem: operation({
    input: updateItemSchema,
    output: resourceSchema,
    handler: (input, { instance }) => updateItem(instance, input),
  }),
  setTrayMenu: operation({
    input: z.strictObject({
      menuId: idSchema.nullable(),
    }),
    output: z.null(),
    handler: (input, { instance }) => setTrayMenu(instance, input),
  }),
  getTrayMenu: operation({
    input: z.null(),
    output: idSchema.nullable(),
    handler: (_input, { instance }) => getTrayMenu(instance),
  }),
  waitForClick: operation({
    input: z.null(),
    output: clickedSchema,
    handler: (_input, { instance, signal }) => waitForClick(instance, signal),
  }),
};
