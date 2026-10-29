import { isWindowsFileName } from "@bunaway/protocol";
import { z } from "zod";

/** Largest serialized store file. An `entries` result must fit one 1 MiB protocol message. */
export const MAX_STORE_FILE_BYTES = 512 * 1024;
/** Largest serialized value of one key. */
export const MAX_STORE_VALUE_BYTES = 256 * 1024;
/** Most keys one store holds. */
export const MAX_STORE_KEYS = 1024;
/** Longest key, in UTF-16 code units. */
export const MAX_STORE_KEY_LENGTH = 256;
/** Longest store name, in characters. */
export const MAX_STORE_NAME_LENGTH = 64;
/** Most stores one app keeps open at a time. */
export const MAX_OPEN_STORES = 16;
/** Autosave debounce used when `load` does not name one, in milliseconds. */
export const DEFAULT_AUTOSAVE_DELAY_MS = 100;
/** Longest autosave debounce, in milliseconds. */
export const MAX_AUTOSAVE_DELAY_MS = 10_000;

const STORE_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

/**
 * Store name: lowercase letters, digits, `-` and `_`. The file name must also be valid on
 * Windows on every platform, so a name such as `con` is refused everywhere.
 */
export const storeNameSchema = z
  .string()
  .min(1)
  .max(MAX_STORE_NAME_LENGTH)
  .regex(STORE_NAME_PATTERN)
  .refine((name) => isWindowsFileName(`${name}.json`), "Reserved file name.");

const storeKeySchema = z.string().min(1).max(MAX_STORE_KEY_LENGTH);
/** Any JSON value; the serialized size is checked by the store, which knows the byte limit. */
export const storeValueSchema = z.json();
/** A value a store keeps. */
export type StoreValue = z.infer<typeof storeValueSchema>;
/** Key and value pairs in insertion order. */
export type StoreRecord = Record<string, StoreValue>;

/** Used by `load`: the keys a store starts with when the file lacks them. */
const defaultsSchema = z.record(storeKeySchema, storeValueSchema);

const named = {
  name: storeNameSchema,
};

/** Debounce in milliseconds, or `false` to write only on `save`, `close` and shutdown. */
const autosaveSchema = z.union([
  z.literal(false),
  z.number().int().min(0).max(MAX_AUTOSAVE_DELAY_MS),
]);

export const loadInputSchema = z.strictObject({
  ...named,
  defaults: defaultsSchema.exactOptional(),
  autosave: autosaveSchema.exactOptional(),
  onInvalidFile: z
    .enum([
      "error",
      "reset",
    ])
    .exactOptional(),
});
/** Input of `store.load`. */
export type StoreLoadInput = z.infer<typeof loadInputSchema>;

export const loadOutputSchema = z.strictObject({
  loaded: z.enum([
    "file",
    "new",
    "reset",
  ]),
});
export const nameInputSchema = z.strictObject(named);
export const keyInputSchema = z.strictObject({
  ...named,
  key: storeKeySchema,
});
export const setInputSchema = z.strictObject({
  ...named,
  key: storeKeySchema,
  value: storeValueSchema,
});
export const reloadInputSchema = z.strictObject({
  ...named,
  ignoreDefaults: z.boolean().exactOptional(),
});
export const getOutputSchema = z.strictObject({
  found: z.boolean(),
  value: storeValueSchema.exactOptional(),
});
export const entriesOutputSchema = z.array(
  z.tuple([
    storeKeySchema,
    storeValueSchema,
  ]),
);
export const changedOutputSchema = z.strictObject({
  changed: z.boolean(),
});
/** Result of `store.get`: a stored `null` is found, a missing key is not. */
export type StoreGetResult = z.infer<typeof getOutputSchema>;
/** Whether a mutation changed the store's contents. */
export type StoreChange = z.infer<typeof changedOutputSchema>;
/** How `store.load` obtained the contents. */
export type StoreLoadResult = z.infer<typeof loadOutputSchema>;

/** What changed in a `store.changed` event. */
export const STORE_CHANGE_KINDS = [
  "set",
  "delete",
  "clear",
  "reset",
  "reload",
] as const;
export type StoreChangeKind = (typeof STORE_CHANGE_KINDS)[number];
/**
 * Operation a view needs to receive `store.changed`. The event names the changed key, so it
 * reaches only views allowed to list keys.
 */
export const STORE_CHANGED_REQUIRED_OPERATION = "store.keys";
/**
 * `store.changed` payload. `key` is present for `set` and `delete` only; the value is never sent,
 * so a receiver reads it with `store.get` under that call's own permission.
 */
export const storeEvents = {
  "store.changed": {
    type: "object",
    properties: {
      name: {
        type: "string",
        minLength: 1,
        maxLength: MAX_STORE_NAME_LENGTH,
      },
      kind: {
        enum: [
          ...STORE_CHANGE_KINDS,
        ],
      },
      key: {
        type: "string",
        minLength: 1,
        maxLength: MAX_STORE_KEY_LENGTH,
      },
    },
    required: [
      "name",
      "kind",
    ],
    additionalProperties: false,
  },
} as const;

/** What every platform adapter provides; operations are typed by this interface, not by a platform module. */
export interface StoreInstance {
  load(input: StoreLoadInput): StoreLoadResult;
  get(name: string, key: string): StoreGetResult;
  has(name: string, key: string): boolean;
  keys(name: string): string[];
  entries(name: string): Array<
    [
      string,
      StoreValue,
    ]
  >;
  length(name: string): number;
  set(name: string, key: string, value: StoreValue): StoreChange;
  delete(name: string, key: string): StoreChange;
  clear(name: string): StoreChange;
  reset(name: string): StoreChange;
  reload(name: string, ignoreDefaults: boolean): StoreChange;
  save(name: string): null;
  close(name: string): null;
}
