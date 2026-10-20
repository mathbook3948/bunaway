import { defineNativeOperation } from "@bunaway/plugin";
import { z } from "zod";
import {
  changedOutputSchema,
  entriesOutputSchema,
  getOutputSchema,
  keyInputSchema,
  loadInputSchema,
  loadOutputSchema,
  nameInputSchema,
  reloadInputSchema,
  type StoreInstance,
  setInputSchema,
} from "#store/contract";

const operation = defineNativeOperation<StoreInstance>();
/** Each operation requires its own permission, named after the operation. */
export const storeOperations = {
  load: operation({
    input: loadInputSchema,
    output: loadOutputSchema,
    handler: (input, { instance }) => instance.load(input),
  }),
  get: operation({
    input: keyInputSchema,
    output: getOutputSchema,
    handler: ({ name, key }, { instance }) => instance.get(name, key),
  }),
  has: operation({
    input: keyInputSchema,
    output: z.boolean(),
    handler: ({ name, key }, { instance }) => instance.has(name, key),
  }),
  keys: operation({
    input: nameInputSchema,
    output: z.array(z.string()),
    handler: ({ name }, { instance }) => instance.keys(name),
  }),
  entries: operation({
    input: nameInputSchema,
    output: entriesOutputSchema,
    handler: ({ name }, { instance }) => instance.entries(name),
  }),
  length: operation({
    input: nameInputSchema,
    output: z.number().int().nonnegative(),
    handler: ({ name }, { instance }) => instance.length(name),
  }),
  set: operation({
    input: setInputSchema,
    output: changedOutputSchema,
    handler: ({ name, key, value }, { instance }) =>
      instance.set(name, key, value),
  }),
  delete: operation({
    input: keyInputSchema,
    output: changedOutputSchema,
    handler: ({ name, key }, { instance }) => instance.delete(name, key),
  }),
  clear: operation({
    input: nameInputSchema,
    output: changedOutputSchema,
    handler: ({ name }, { instance }) => instance.clear(name),
  }),
  reset: operation({
    input: nameInputSchema,
    output: changedOutputSchema,
    handler: ({ name }, { instance }) => instance.reset(name),
  }),
  reload: operation({
    input: reloadInputSchema,
    output: changedOutputSchema,
    handler: ({ name, ignoreDefaults }, { instance }) =>
      instance.reload(name, ignoreDefaults ?? false),
  }),
  save: operation({
    input: nameInputSchema,
    output: z.null(),
    handler: ({ name }, { instance }) => instance.save(name),
  }),
  close: operation({
    input: nameInputSchema,
    output: z.null(),
    handler: ({ name }, { instance }) => instance.close(name),
  }),
};
