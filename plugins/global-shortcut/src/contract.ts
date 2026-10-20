import { z } from "zod";
export const MAX_GLOBAL_SHORTCUTS = 128;
export const MAX_SHORTCUT_WAITERS = 16;
const modifiers = [
  "Control",
  "Alt",
  "Shift",
  "Super",
] as const;
const keys = [
  "A",
  "B",
  "C",
  "D",
  "E",
  "F",
  "G",
  "H",
  "I",
  "J",
  "K",
  "L",
  "M",
  "N",
  "O",
  "P",
  "Q",
  "R",
  "S",
  "T",
  "U",
  "V",
  "W",
  "X",
  "Y",
  "Z",
  "0",
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "F1",
  "F2",
  "F3",
  "F4",
  "F5",
  "F6",
  "F7",
  "F8",
  "F9",
  "F10",
  "F11",
  "F13",
  "F14",
  "F15",
  "F16",
  "F17",
  "F18",
  "F19",
  "F20",
  "F21",
  "F22",
  "F23",
  "F24",
  "Backspace",
  "Tab",
  "Enter",
  "Escape",
  "Space",
  "PageUp",
  "PageDown",
  "End",
  "Home",
  "Left",
  "Up",
  "Right",
  "Down",
  "Insert",
  "Delete",
] as const;
/** Explicit virtual-key names; F12 is reserved by Windows and is not accepted. */
export const shortcutSchema = z.strictObject({
  key: z.enum(keys),
  modifiers: z
    .array(z.enum(modifiers))
    .min(1)
    .max(4)
    .refine(
      (values) => new Set(values).size === values.length,
      "Duplicate modifier.",
    )
    .transform((values) =>
      modifiers.filter((modifier) => values.includes(modifier)),
    ),
});
export type GlobalShortcut = z.output<typeof shortcutSchema>;
const shortcutEventPayload = {
  type: "object",
  properties: {
    shortcut: {
      type: "object",
      properties: {
        key: {
          type: "string",
          enum: [
            ...keys,
          ],
        },
        modifiers: {
          type: "array",
          items: {
            type: "string",
            enum: [
              ...modifiers,
            ],
          },
          minItems: 1,
          maxItems: 4,
        },
      },
      required: [
        "key",
        "modifiers",
      ],
      additionalProperties: false,
    },
  },
  required: [
    "shortcut",
  ],
  additionalProperties: false,
} as const;

/**
 * `released` shares the `pressed` payload. It is a separate event, so views that only allow
 * `globalShortcut.pressed` never receive it.
 */
export const globalShortcutEvents = {
  "globalShortcut.pressed": {
    payload: shortcutEventPayload,
  },
  "globalShortcut.released": {
    payload: shortcutEventPayload,
  },
} as const;

/** Canonical identity is independent of modifier input order. */
export function shortcutId(shortcut: GlobalShortcut): string {
  return [
    ...shortcut.modifiers,
    shortcut.key,
  ].join("+");
}

/**
 * What the operations call on a platform adapter. Each platform class implements it, so
 * `operations.ts` stays free of platform imports. Registration fails with BUSY for an already
 * owned combination or while suspended, and `dispose` removes every registration and is safe to
 * repeat.
 */
export interface GlobalShortcutInstance {
  register(shortcut: GlobalShortcut): null;
  registerMany(shortcuts: GlobalShortcut[]): null;
  isRegistered(shortcut: GlobalShortcut): boolean;
  list(): GlobalShortcut[];
  unregister(shortcut: GlobalShortcut): boolean;
  unregisterAll(): null;
  setSuspended(suspended: boolean): null;
  isSuspended(): boolean;
  /** Settles with the next press; rejects with CANCELLED on abort or BUSY when too many wait. */
  waitForPress(signal?: AbortSignal): Promise<{
    shortcut: GlobalShortcut;
  }>;
  dispose(): void;
}
