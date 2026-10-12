import type { NativeMenuItem } from "@bunaway/plugin-api/native";
import { z } from "zod";

export const MAX_MENU_RESOURCES = 32;
export const MAX_MENU_ITEMS = 256;
export const MAX_MENU_DEPTH = 8;
const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_.-]+$/);
const label = z.string().min(1).max(512).refine((text) => !/[\0\t\r\n]/.test(text));
const base = { id, visible: z.boolean().default(true) };
const action = {
  ...base,
  label,
  enabled: z.boolean().default(true),
  checked: z.boolean().default(false),
  group: id.nullable().default(null),
};
// Bound the tree before recursive parsing so hostile input cannot exhaust the JS stack.
const boundedTree = z.unknown().superRefine((value, context) => {
  const pending = [{ value, depth: 1 }];
  let count = 0;
  while (pending.length) {
    const next = pending.pop();
    if (!next || !Array.isArray(next.value) || next.depth > MAX_MENU_DEPTH) {
      context.addIssue({ code: "custom", message: "Invalid menu tree." });
      return;
    }
    count += next.value.length;
    if (count > MAX_MENU_ITEMS) {
      context.addIssue({ code: "custom", message: "Menu item limit exceeded." });
      return;
    }
    for (const item of next.value) {
      if (item && typeof item === "object" && "items" in item) {
        pending.push({ value: item.items, depth: next.depth + 1 });
      }
    }
  }
});
const itemSchema: z.ZodType<NativeMenuItem, unknown> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.strictObject({ ...base, type: z.literal("separator") }),
    z.strictObject({ ...action, type: z.enum(["item", "checkbox", "radio"]) }),
    z.strictObject({
      ...base,
      type: z.literal("submenu"),
      label,
      enabled: z.boolean().default(true),
      items: z.array(itemSchema),
    }),
  ]),
);
/** Resolved tree shared by tray integration and future window menu consumers. */
export const menuItemsSchema = boundedTree.pipe(z.array(itemSchema)).superRefine((items, context) => {
  const ids = new Set<string>();
  const visit = (siblings: NativeMenuItem[]) => {
    const checkedGroups = new Set<string>();
    for (const item of siblings) {
      if (ids.has(item.id)) {
        context.addIssue({ code: "custom", message: "Duplicate menu item ID." });
      }
      ids.add(item.id);
      if (item.type === "submenu") {
        visit(item.items);
      } else if (item.type !== "separator") {
        if ((item.type === "radio") !== (item.group !== null) || (item.type === "item" && item.checked)) {
          context.addIssue({ code: "custom", message: "Invalid checked state or radio group." });
        }
        if (item.type === "radio" && item.checked && item.group !== null) {
          if (checkedGroups.has(item.group)) {
            context.addIssue({ code: "custom", message: "Multiple checked items in radio group." });
          }
          checkedGroups.add(item.group);
        }
      }
    }
  };
  visit(items);
});
const resource = z.strictObject({ menuId: id, items: menuItemsSchema });
const target = z.strictObject({ menuId: id });
export const menuOperations = {
  create: { input: resource, output: resource },
  get: { input: target, output: resource.nullable() },
  list: { input: z.null(), output: z.array(resource) },
  replace: { input: resource, output: resource },
  remove: { input: target, output: z.boolean() },
  insert: {
    input: z.strictObject({ menuId: id, parentId: id.nullable().default(null), index: z.number().int().min(0).max(MAX_MENU_ITEMS), item: z.unknown() }),
    output: resource,
  },
  removeItem: { input: z.strictObject({ menuId: id, itemId: id }), output: resource },
  updateItem: {
    input: z.strictObject({ menuId: id, itemId: id, changes: z.strictObject({ label: label.optional(), enabled: z.boolean().optional(), visible: z.boolean().optional(), checked: z.boolean().optional() }) }),
    output: resource,
  },
  setTrayMenu: { input: z.strictObject({ menuId: id.nullable() }), output: z.null() },
  getTrayMenu: { input: z.null(), output: id.nullable() },
};
/** Selection reports IDs; checkbox and radio state changes remain explicit app operations. */
export const menuEvents = {
  "menu.clicked": { payload: { type: "object", properties: { menuId: { type: "string" }, itemId: { type: "string" }, source: { const: "tray" }, windowId: { const: null } }, required: ["menuId", "itemId", "source", "windowId"], additionalProperties: false } },
} as const;
