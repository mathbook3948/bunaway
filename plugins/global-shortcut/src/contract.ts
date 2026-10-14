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
export const globalShortcutEvents = {
  "globalShortcut.pressed": {
    payload: {
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
    },
  },
} as const;

/** Canonical identity is independent of modifier input order. */
export function shortcutId(shortcut: GlobalShortcut): string {
  return [
    ...shortcut.modifiers,
    shortcut.key,
  ].join("+");
}
