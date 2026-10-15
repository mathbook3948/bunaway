import type { NativeMenuItem } from "@bunaway/plugin-api/native";
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
      type: "item" | "checkbox" | "radio";
      label: string;
      enabled?: boolean | undefined;
      visible?: boolean | undefined;
      checked?: boolean | undefined;
      group?: string | null | undefined;
    }
  | {
      id: string;
      type: "submenu";
      label: string;
      enabled?: boolean | undefined;
      visible?: boolean | undefined;
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
  z.discriminatedUnion("type", [
    z.strictObject({
      ...base,
      type: z.literal("separator"),
    }),
    z.strictObject({
      ...action,
      type: z.enum([
        "item",
        "checkbox",
        "radio",
      ]),
    }),
    z.strictObject({
      ...base,
      type: z.literal("submenu"),
      label: labelSchema,
      enabled: z.boolean().default(true),
      items: z.array(itemSchema),
    }),
  ]),
);
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

/** Targets a particular HWND lifetime, never a view or a raw native handle. */
export const windowTargetSchema = z.strictObject({
  windowId: idSchema,
});
export const windowMenuSchema = windowTargetSchema.extend({
  menuId: idSchema.nullable(),
});
/** Context-popup coordinates are physical screen pixels (including negative monitor origins). */
export const contextMenuSchema = windowTargetSchema.extend({
  menuId: idSchema,
  x: z.number().int().min(-2147483648).max(2147483647),
  y: z.number().int().min(-2147483648).max(2147483647),
});
