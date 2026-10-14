import { z } from "zod";

export const MAX_GLOBAL_SHORTCUTS = 128;
export const MAX_SHORTCUT_WAITERS = 16;
export const WM_HOTKEY = 0x0312;
export const MOD_NOREPEAT = 0x4000;
export const MAX_HOTKEY_ID = 0xbfff;
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
const modifierFlags = {
  Alt: 1,
  Control: 2,
  Shift: 4,
  Super: 8,
} as const;
const namedKeys = {
  Backspace: 0x08,
  Tab: 0x09,
  Enter: 0x0d,
  Escape: 0x1b,
  Space: 0x20,
  PageUp: 0x21,
  PageDown: 0x22,
  End: 0x23,
  Home: 0x24,
  Left: 0x25,
  Up: 0x26,
  Right: 0x27,
  Down: 0x28,
  Insert: 0x2d,
  Delete: 0x2e,
} as const;
/** Map the validated contract to Win32 modifiers and virtual-key codes. */
export function hotkeyCodes(shortcut: GlobalShortcut): {
  modifiers: number;
  key: number;
} {
  const modifiers = shortcut.modifiers.reduce(
    (flags, modifier) => flags | modifierFlags[modifier],
    0,
  );
  const key =
    shortcut.key.length === 1
      ? shortcut.key.charCodeAt(0)
      : shortcut.key.startsWith("F")
        ? 0x70 + Number(shortcut.key.slice(1)) - 1
        : namedKeys[shortcut.key as keyof typeof namedKeys];
  return {
    modifiers,
    key,
  };
}
