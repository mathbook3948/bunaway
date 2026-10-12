import type { NativeAdapter, NativeEnvironment } from "@bunaway/plugin";
import type { NativeMenuItem } from "@bunaway/plugin-api/native";
import { BunawayError, validateValue } from "@bunaway/protocol";
import {
  MAX_MENU_RESOURCES,
  menuItemsSchema,
  menuOperations,
} from "../contract.ts";

function invalid(message: string): never {
  throw new BunawayError({
    code: "INVALID_ARGUMENT",
    message,
  });
}
function locate(
  items: NativeMenuItem[],
  itemId: string,
):
  | {
      siblings: NativeMenuItem[];
      index: number;
    }
  | undefined {
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    if (item?.id === itemId) {
      return {
        siblings: items,
        index,
      };
    }
    if (item?.type === "submenu") {
      const found = locate(item.items, itemId);
      if (found) {
        return found;
      }
    }
  }
  return undefined;
}

/** Owns bounded menu definitions and the tray attachment on the UI thread. Mutations commit atomically. */
export function createOperations(
  environment: NativeEnvironment,
): NativeAdapter {
  const resources = new Map<string, NativeMenuItem[]>();
  let attached: string | null = null;
  let changed = false;
  let revision = 0;
  let disposed = false;
  const snapshot = (menuId: string, items: NativeMenuItem[]) =>
    validateValue(
      {},
      {
        menuId,
        items: structuredClone(items),
      },
    );
  const requireMenu = (menuId: string) =>
    resources.get(menuId) ?? invalid("Menu resource does not exist.");
  const attach = (menuId: string | null, items: NativeMenuItem[] | null) => {
    if (!environment.menus) {
      throw new BunawayError({
        code: "UNSUPPORTED",
        message: "Native tray menus are unavailable.",
      });
    }
    const nextRevision = revision + 1;
    environment.menus.setTrayMenu(
      items === null ? null : structuredClone(items),
      (itemId) => {
        // A native popup can pump host requests. Never publish a selection from a replaced definition.
        if (disposed || revision !== nextRevision || menuId === null) {
          return;
        }
        environment.menus?.emit("menu.clicked", {
          menuId,
          itemId,
          source: "tray",
          windowId: null,
        });
      },
    );
    revision = nextRevision;
    attached = menuId;
    changed = true;
  };
  const commit = (menuId: string, items: unknown) => {
    let parsed: NativeMenuItem[];
    try {
      parsed = menuItemsSchema.parse(items);
    } catch {
      return invalid("Invalid menu tree.");
    }
    if (attached === menuId) {
      attach(menuId, parsed);
    }
    resources.set(menuId, parsed);
    return snapshot(menuId, parsed);
  };
  return {
    execute() {
      throw new BunawayError({
        code: "UNSUPPORTED",
        message: "Menu resources require UI execution.",
      });
    },
    executeUI(name, input, _source, context) {
      if (disposed || context.signal?.aborted) {
        throw new BunawayError({
          code: "CANCELLED",
          message: "Menu operation cancelled.",
        });
      }
      if (!context.permissions.permissions.includes(name)) {
        throw new BunawayError({
          code: "PERMISSION_DENIED",
          message: "Menu permission denied.",
        });
      }
      // The SDK parses external input before entry. Parsing here resolves concrete operation types.
      const parse = <T>(run: () => T): T => {
        try {
          return run();
        } catch (error) {
          if (error instanceof BunawayError) {
            throw error;
          }
          return invalid("Invalid menu input.");
        }
      };
      switch (name) {
        case "menu.create": {
          const { menuId, items } = parse(() =>
            menuOperations.create.input.parse(input),
          );
          if (resources.has(menuId)) {
            throw new BunawayError({
              code: "BUSY",
              message: "Menu ID is already registered.",
            });
          }
          if (resources.size >= MAX_MENU_RESOURCES) {
            throw new BunawayError({
              code: "BUSY",
              message: "Menu resource limit reached.",
            });
          }
          return commit(menuId, items);
        }
        case "menu.get": {
          const { menuId } = parse(() => menuOperations.get.input.parse(input));
          const items = resources.get(menuId);
          return items ? snapshot(menuId, items) : null;
        }
        case "menu.list":
          parse(() => menuOperations.list.input.parse(input));
          return [
            ...resources.keys(),
          ];
        case "menu.replace": {
          const { menuId, items } = parse(() =>
            menuOperations.replace.input.parse(input),
          );
          requireMenu(menuId);
          return commit(menuId, items);
        }
        case "menu.remove": {
          const { menuId } = parse(() =>
            menuOperations.remove.input.parse(input),
          );
          if (!resources.has(menuId)) {
            return false;
          }
          if (attached === menuId) {
            attach(null, null);
          }
          return resources.delete(menuId);
        }
        case "menu.insert": {
          const { menuId, parentId, index, item } = parse(() =>
            menuOperations.insert.input.parse(input),
          );
          const items = structuredClone(requireMenu(menuId));
          let siblings = items;
          if (parentId !== null) {
            const found = locate(items, parentId);
            const parent = found?.siblings[found.index];
            if (parent?.type !== "submenu") {
              return invalid("Insertion parent is not a submenu.");
            }
            siblings = parent.items;
          }
          if (index > siblings.length) {
            return invalid("Menu insertion index is out of range.");
          }
          // Revalidate the complete candidate, including inserted descendants and IDs, before commit.
          siblings.splice(index, 0, item);
          return commit(menuId, items);
        }
        case "menu.removeItem":
        case "menu.updateItem": {
          const args = parse(() =>
            name === "menu.removeItem"
              ? menuOperations.removeItem.input.parse(input)
              : menuOperations.updateItem.input.parse(input),
          );
          const items = structuredClone(requireMenu(args.menuId));
          const found =
            locate(items, args.itemId) ?? invalid("Menu item does not exist.");
          if (name === "menu.updateItem") {
            const { changes } = parse(() =>
              menuOperations.updateItem.input.parse(input),
            );
            const old = found.siblings[found.index];
            if (!old) {
              return invalid("Menu item does not exist.");
            }
            if (
              old.type === "separator" &&
              Object.keys(changes).some((key) => key !== "visible")
            ) {
              return invalid("Separator only supports visibility changes.");
            }
            if (old.type === "submenu" && changes.checked !== undefined) {
              return invalid("Submenus do not support checked state.");
            }
            Object.assign(old, changes);
          } else {
            found.siblings.splice(found.index, 1);
          }
          return commit(args.menuId, items);
        }
        case "menu.setTrayMenu": {
          const { menuId } = parse(() =>
            menuOperations.setTrayMenu.input.parse(input),
          );
          attach(menuId, menuId === null ? null : requireMenu(menuId));
          return null;
        }
        case "menu.getTrayMenu":
          parse(() => menuOperations.getTrayMenu.input.parse(input));
          return attached;
        default:
          throw new BunawayError({
            code: "UNSUPPORTED",
            message: "Menu operation is not registered.",
          });
      }
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      revision++;
      resources.clear();
      if (changed) {
        environment.menus?.setTrayMenu(undefined);
      }
      attached = null;
    },
  };
}
