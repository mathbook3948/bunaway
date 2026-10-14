import { defineNativeOperation } from "@bunaway/plugin";
import { z } from "zod";
import {
  MAX_GLOBAL_SHORTCUTS,
  shortcutSchema,
} from "#global-shortcut/contract";
import type { initialize } from "#global-shortcut/platforms/windows";

const operation = defineNativeOperation<ReturnType<typeof initialize>>();
/** App-owned Windows shortcuts and cancellable press waits. Each operation needs its own grant. */
export const globalShortcutOperations = {
  register: operation({
    input: shortcutSchema,
    output: z.null(),
    handler: (input, { instance }) => instance.register(input),
  }),
  registerMany: operation({
    input: z.strictObject({
      shortcuts: z.array(shortcutSchema).min(1).max(MAX_GLOBAL_SHORTCUTS),
    }),
    output: z.null(),
    handler: ({ shortcuts }, { instance }) => instance.registerMany(shortcuts),
  }),
  isRegistered: operation({
    input: shortcutSchema,
    output: z.boolean(),
    handler: (input, { instance }) => instance.isRegistered(input),
  }),
  list: operation({
    input: z.null(),
    output: z.array(shortcutSchema).max(MAX_GLOBAL_SHORTCUTS),
    handler: (_input, { instance }) => instance.list(),
  }),
  unregister: operation({
    input: shortcutSchema,
    output: z.boolean(),
    handler: (input, { instance }) => instance.unregister(input),
  }),
  unregisterAll: operation({
    input: z.null(),
    output: z.null(),
    handler: (_input, { instance }) => instance.unregisterAll(),
  }),
  setSuspended: operation({
    input: z.strictObject({
      suspended: z.boolean(),
    }),
    output: z.null(),
    handler: ({ suspended }, { instance }) => instance.setSuspended(suspended),
  }),
  isSuspended: operation({
    input: z.null(),
    output: z.boolean(),
    handler: (_input, { instance }) => instance.isSuspended(),
  }),
  waitForPress: operation({
    input: z.null(),
    output: z.strictObject({
      shortcut: shortcutSchema,
    }),
    handler: (_input, { instance, signal }) => instance.waitForPress(signal),
  }),
};
