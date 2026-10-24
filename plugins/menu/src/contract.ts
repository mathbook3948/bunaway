import { int32Schema } from "@bunaway/plugin";
import {
  MAX_NATIVE_ICO_BYTES,
  type NativeMenuItem,
  type NativeMenuRole,
  parseNativeIco,
} from "@bunaway/plugin-api/native";
import { z } from "zod";
export const MAX_MENU_RESOURCES = 32;
export const MAX_MENU_ITEMS = 256;
export const MAX_MENU_DEPTH = 8;
export const MAX_MENU_WAITERS = 16;
export const idSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_.-]+$(?![\s\S])/);
export const labelSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[^\0\t\r\n\uD800-\uDFFF]*$(?![\s\S])/u);
const ACCELERATOR_MODIFIER_ORDER = [
  "Ctrl",
  "Alt",
  "Shift",
  "Win",
] as const;
/** Spellings accepted for a modifier; `CommandOrControl` is Ctrl because Windows has no Command key. */
const ACCELERATOR_MODIFIER_ALIASES: Readonly<
  Record<string, (typeof ACCELERATOR_MODIFIER_ORDER)[number]>
> = {
  ctrl: "Ctrl",
  control: "Ctrl",
  commandorcontrol: "Ctrl",
  cmdorctrl: "Ctrl",
  alt: "Alt",
  shift: "Shift",
  win: "Win",
  super: "Win",
};
const ACCELERATOR_NAMED_KEYS = [
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
const ACCELERATOR_FUNCTION_KEY = /^F(?:[1-9]|1\d|2[0-4])$/i;
const ACCELERATOR_PLAIN_KEY = /^[A-Za-z0-9]$/;
export const MAX_ACCELERATOR_LENGTH = 64;
/** Canonical spelling of a key part, or undefined when it names no supported key. */
function canonicalAcceleratorKey(part: string): string | undefined {
  if (ACCELERATOR_PLAIN_KEY.test(part) || ACCELERATOR_FUNCTION_KEY.test(part)) {
    return part.toUpperCase();
  }
  return ACCELERATOR_NAMED_KEYS.find(
    (name) => name.toLowerCase() === part.toLowerCase(),
  );
}
/**
 * Normalize `Ctrl+Shift+N` style text to modifiers in Ctrl, Alt, Shift, Win order followed by one
 * key, or undefined when the text is not a supported combination. The result is display text only.
 */
export function normalizeAccelerator(text: string): string | undefined {
  const parts = text.split("+");
  const key = canonicalAcceleratorKey(parts.pop() ?? "");
  if (key === undefined) {
    return undefined;
  }
  const modifiers = new Set<string>();
  for (const part of parts) {
    const alias = part.toLowerCase();
    // Own keys only: names such as `constructor` must not resolve through the prototype.
    const modifier = Object.hasOwn(ACCELERATOR_MODIFIER_ALIASES, alias)
      ? ACCELERATOR_MODIFIER_ALIASES[alias]
      : undefined;
    if (modifier === undefined || modifiers.has(modifier)) {
      return undefined;
    }
    modifiers.add(modifier);
  }
  return [
    ...ACCELERATOR_MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier)),
    key,
  ].join("+");
}
/**
 * Shortcut text drawn at the right edge of a menu item. It is not a registered shortcut: the app
 * handles the key itself. Electron and Tauri also register the key; this framework only displays it.
 */
export const acceleratorSchema = z
  .string()
  .max(MAX_ACCELERATOR_LENGTH)
  .transform((text, context) => {
    const normalized = normalizeAccelerator(text);
    if (normalized === undefined) {
      context.addIssue({
        code: "custom",
        message: "Unsupported accelerator.",
      });
      return z.NEVER;
    }
    return normalized;
  });
/**
 * Base64 ICO, the same input as the tray `setIcon`. The directory is checked here so a malformed
 * icon is rejected as INVALID_ARGUMENT before any native resource exists.
 */
export const iconSchema = z
  .string()
  .min(4)
  .max(Math.ceil(MAX_NATIVE_ICO_BYTES / 3) * 4)
  .refine((value) => parseNativeIco(value) !== undefined, "Invalid ICO.");
/** Role default labels, which are Electron's Windows labels; accelerators are drawn by the native menu. */
export const MENU_ROLE_LABELS = {
  undo: "Undo",
  redo: "Redo",
  cut: "Cut",
  copy: "Copy",
  paste: "Paste",
  selectAll: "Select All",
  close: "Close",
  minimize: "Minimize",
  quit: "Exit",
} as const satisfies Record<NativeMenuRole, string>;
export const roleSchema = z.enum(
  Object.keys(MENU_ROLE_LABELS) as [
    NativeMenuRole,
    ...NativeMenuRole[],
  ],
);
const base = {
  id: idSchema,
  visible: z.boolean().default(true),
};
const action = {
  ...base,
  label: labelSchema,
  enabled: z.boolean().default(true),
  checked: z.boolean().default(false),
  group: idSchema.nullable().default(null),
  accelerator: acceleratorSchema.nullable().default(null),
};
/** Only plain items and submenus show an icon; checkbox and radio use that column for their mark. */
const icon = {
  icon: iconSchema.nullable().default(null),
};
// Bound the tree before recursive parsing so hostile input cannot exhaust the JS stack.
type MenuItemInput =
  | {
      id: string;
      type: "separator";
      visible?: boolean | undefined;
    }
  | {
      id: string;
      type: "item";
      /** Required unless `role` supplies a default. */
      label?: string | undefined;
      role?: NativeMenuRole | undefined;
      enabled?: boolean | undefined;
      visible?: boolean | undefined;
      checked?: boolean | undefined;
      group?: string | null | undefined;
      icon?: string | null | undefined;
      accelerator?: string | null | undefined;
    }
  | {
      id: string;
      type: "checkbox" | "radio";
      label: string;
      enabled?: boolean | undefined;
      visible?: boolean | undefined;
      checked?: boolean | undefined;
      group?: string | null | undefined;
      accelerator?: string | null | undefined;
    }
  | {
      id: string;
      type: "submenu";
      label: string;
      enabled?: boolean | undefined;
      visible?: boolean | undefined;
      icon?: string | null | undefined;
      items: MenuItemInput[];
    };
const boundedTree = z
  .custom<MenuItemInput[]>(Array.isArray)
  .superRefine((value, context) => {
    const pending: {
      value: unknown;
      depth: number;
    }[] = [
      {
        value,
        depth: 1,
      },
    ];
    let count = 0;
    while (pending.length) {
      const next = pending.pop();
      if (!next || !Array.isArray(next.value) || next.depth > MAX_MENU_DEPTH) {
        context.addIssue({
          code: "custom",
          message: "Invalid menu tree.",
        });
        return;
      }
      count += next.value.length;
      if (count > MAX_MENU_ITEMS) {
        context.addIssue({
          code: "custom",
          message: "Menu item limit exceeded.",
        });
        return;
      }
      for (const item of next.value) {
        if (item && typeof item === "object" && "items" in item) {
          pending.push({
            value: item.items,
            depth: next.depth + 1,
          });
        }
      }
    }
  });
const itemSchema: z.ZodType<NativeMenuItem, MenuItemInput> = z.lazy(() =>
  z
    .discriminatedUnion("type", [
      z.strictObject({
        ...base,
        type: z.literal("separator"),
      }),
      z.strictObject({
        ...action,
        ...icon,
        label: labelSchema.optional(),
        type: z.literal("item"),
        role: roleSchema.optional(),
      }),
      z.strictObject({
        ...action,
        type: z.enum([
          "checkbox",
          "radio",
        ]),
      }),
      z.strictObject({
        ...base,
        type: z.literal("submenu"),
        label: labelSchema,
        enabled: z.boolean().default(true),
        ...icon,
        items: z.array(itemSchema),
      }),
    ])
    .transform((item, context) => {
      if (item.type !== "item") {
        return item;
      }
      // Only a role item may omit its label; the role then supplies its default label.
      const label = item.label ?? (item.role && MENU_ROLE_LABELS[item.role]);
      if (label === undefined) {
        context.issues.push({
          code: "custom",
          message: "Menu item label is required without a role.",
          input: item,
        });
        return z.NEVER;
      }
      return {
        ...item,
        label,
      };
    }),
);
type ActionableMenuItem = Exclude<
  NativeMenuItem,
  {
    type: "submenu" | "separator";
  }
>;
/**
 * Checked state and radio group rules for one item that is neither a submenu nor a separator.
 * `checkedGroups` holds the radio groups that already have a checked item among the same siblings.
 */
function checkActionableItem(
  item: ActionableMenuItem,
  checkedGroups: Set<string>,
  context: z.RefinementCtx,
): void {
  if (
    (item.type === "radio") !== (item.group !== null) ||
    (item.type === "item" && item.checked)
  ) {
    context.addIssue({
      code: "custom",
      message: "Invalid checked state or radio group.",
    });
  }
  if (item.type === "radio" && item.checked && item.group !== null) {
    if (checkedGroups.has(item.group)) {
      context.addIssue({
        code: "custom",
        message: "Multiple checked items in radio group.",
      });
    }
    checkedGroups.add(item.group);
  }
}
/** Resolved tree shared by tray integration and future window menu consumers. */
export const menuItemsSchema = boundedTree
  .pipe(z.array(itemSchema))
  .superRefine((items, context) => {
    const ids = new Set<string>();
    const visit = (siblings: NativeMenuItem[]) => {
      const checkedGroups = new Set<string>();
      for (const item of siblings) {
        if (ids.has(item.id)) {
          context.addIssue({
            code: "custom",
            message: "Duplicate menu item ID.",
          });
        }
        ids.add(item.id);
        if (item.type === "submenu") {
          visit(item.items);
        } else if (item.type !== "separator") {
          checkActionableItem(item, checkedGroups, context);
        }
      }
    };
    visit(items);
  });
export const resourceSchema = z.strictObject({
  menuId: idSchema,
  items: menuItemsSchema,
});
export const targetSchema = z.strictObject({
  menuId: idSchema,
});
export const clickedSchema = z.strictObject({
  menuId: idSchema,
  itemId: idSchema,
  source: z.enum([
    "tray",
    "window",
    "context",
  ]),
  windowId: idSchema.nullable(),
});
export const insertedItemSchema = z
  .custom<MenuItemInput>((value) => value !== null && typeof value === "object")
  .superRefine((value, context) => {
    if (
      !boundedTree.safeParse([
        value,
      ]).success
    ) {
      context.addIssue({
        code: "custom",
        message: "Invalid inserted menu tree.",
      });
    }
  })
  .pipe(itemSchema);
export const insertSchema = z.strictObject({
  menuId: idSchema,
  parentId: idSchema.nullable().default(null),
  index: z.number().int().min(0).max(MAX_MENU_ITEMS),
  item: insertedItemSchema,
});
export const itemTargetSchema = z.strictObject({
  menuId: idSchema,
  itemId: idSchema,
});
export const updateItemSchema = itemTargetSchema.extend({
  changes: z.strictObject({
    label: labelSchema.optional(),
    enabled: z.boolean().optional(),
    visible: z.boolean().optional(),
    checked: z.boolean().optional(),
    /** ICO to show, or null to remove the icon. */
    icon: iconSchema.nullable().optional(),
    /** Display-only shortcut text, or null to remove it (a role item then shows its default). */
    accelerator: acceleratorSchema.nullable().optional(),
  }),
});
/** Selection reports IDs; checkbox and radio state changes remain explicit app operations. */
export const menuEvents = {
  "menu.clicked": {
    type: "object",
    properties: {
      menuId: {
        type: "string",
      },
      itemId: {
        type: "string",
      },
      source: {
        enum: [
          "tray",
          "window",
          "context",
        ],
      },
      windowId: {
        anyOf: [
          {
            type: "string",
          },
          {
            const: null,
          },
        ],
      },
    },
    required: [
      "menuId",
      "itemId",
      "source",
      "windowId",
    ],
    additionalProperties: false,
  },
} as const;

export const windowMenuSchema = z.strictObject({
  menuId: idSchema.nullable(),
});
export const windowMenuVisibleSchema = z.strictObject({
  visible: z.boolean(),
});
/** Context-popup coordinates are physical screen pixels (including negative monitor origins). */
export const contextMenuSchema = z.strictObject({
  menuId: idSchema,
  x: int32Schema,
  y: int32Schema,
});
