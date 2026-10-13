import { defineNativeAdapter, NativeEventWaiters } from "@bunaway/plugin";
import type { NativeMenuItem } from "@bunaway/plugin-api/native";
import { BunawayError } from "@bunaway/protocol";
import {
  MAX_MENU_RESOURCES,
  MAX_MENU_WAITERS,
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
export const createOperations = defineNativeAdapter(menuOperations, {
  setup(environment) {
    const resources = new Map<string, NativeMenuItem[]>();
    const clicks = new NativeEventWaiters<
      ReturnType<typeof menuOperations.waitForClick.output.parse>
    >(MAX_MENU_WAITERS);
    let attached: string | null = null;
    let changed = false;
    let revision = 0;
    let disposed = false;
    const snapshot = (menuId: string, items: NativeMenuItem[]) => ({
      menuId,
      items: structuredClone(items),
    });
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
          const payload = {
            menuId,
            itemId,
            source: "tray" as const,
            windowId: null,
          };
          clicks.publish(payload);
          environment.menus?.emit("menu.clicked", payload);
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
      resources,
      clicks,
      requireMenu,
      attach,
      commit,
      snapshot,
      dispose() {
        if (disposed) {
          return;
        }
        disposed = true;
        clicks.dispose();
        revision++;
        resources.clear();
        if (changed) {
          environment.menus?.setTrayMenu(undefined);
        }
        attached = null;
      },
      getAttached: () => attached,
    };
  },
  handlers: {
    create({ menuId, items }, _context, { resources, commit }) {
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
    },
    get({ menuId }, _context, { resources, snapshot }) {
      const items = resources.get(menuId);
      return items ? snapshot(menuId, items) : null;
    },
    list(_input, _context, { resources }) {
      return [
        ...resources.keys(),
      ];
    },
    replace({ menuId, items }, _context, { requireMenu, commit }) {
      requireMenu(menuId);
      return commit(menuId, items);
    },
    remove({ menuId }, _context, { resources, getAttached, attach }) {
      if (!resources.has(menuId)) {
        return false;
      }
      if (getAttached() === menuId) {
        attach(null, null);
      }
      return resources.delete(menuId);
    },
    insert(
      { menuId, parentId, index, item },
      _context,
      { requireMenu, commit },
    ) {
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
    },
    removeItem({ menuId, itemId }, _context, { requireMenu, commit }) {
      const items = structuredClone(requireMenu(menuId));
      const found =
        locate(items, itemId) ?? invalid("Menu item does not exist.");
      found.siblings.splice(found.index, 1);
      return commit(menuId, items);
    },
    updateItem({ menuId, itemId, changes }, _context, { requireMenu, commit }) {
      const items = structuredClone(requireMenu(menuId));
      const found =
        locate(items, itemId) ?? invalid("Menu item does not exist.");
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
      return commit(menuId, items);
    },
    setTrayMenu({ menuId }, _context, { attach, requireMenu }) {
      attach(menuId, menuId === null ? null : requireMenu(menuId));
      return null;
    },
    getTrayMenu: (_input, _context, { getAttached }) => getAttached(),
    waitForClick: (_input, context, { clicks }) => clicks.wait(context.signal),
  },
  dispose(state) {
    state.dispose();
  },
});
