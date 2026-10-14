import { type NativeEnvironment, NativeEventWaiters } from "@bunaway/plugin";
import type { NativeMenuItem } from "@bunaway/plugin-api/native";
import { BunawayError } from "@bunaway/protocol";
import type { z } from "zod";
import {
  type clickedSchema,
  type insertSchema,
  type itemTargetSchema,
  MAX_MENU_RESOURCES,
  MAX_MENU_WAITERS,
  menuItemsSchema,
  type resourceSchema,
  type targetSchema,
  type updateItemSchema,
} from "../contract.ts";

type ResourceInput = z.output<typeof resourceSchema>;
type TargetInput = z.output<typeof targetSchema>;

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

/** Own bounded menu definitions, tray attachment and cancellable click waits. */
export function initialize(environment: NativeEnvironment) {
  const resources = new Map<string, NativeMenuItem[]>();
  const clicks = new NativeEventWaiters<z.output<typeof clickedSchema>>(
    MAX_MENU_WAITERS,
  );
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
        // A native popup can pump host requests. Ignore selections from replaced definitions.
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
    getAttached: () => attached,
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
  };
}

type State = ReturnType<typeof initialize>;

export function create(state: State, { menuId, items }: ResourceInput) {
  if (state.resources.has(menuId)) {
    throw new BunawayError({
      code: "BUSY",
      message: "Menu ID is already registered.",
    });
  }
  if (state.resources.size >= MAX_MENU_RESOURCES) {
    throw new BunawayError({
      code: "BUSY",
      message: "Menu resource limit reached.",
    });
  }
  return state.commit(menuId, items);
}

export function get(state: State, { menuId }: TargetInput) {
  const items = state.resources.get(menuId);
  return items ? state.snapshot(menuId, items) : null;
}

export function list(state: State) {
  return [
    ...state.resources.keys(),
  ];
}

export function replace(state: State, { menuId, items }: ResourceInput) {
  state.requireMenu(menuId);
  return state.commit(menuId, items);
}

export function remove(state: State, { menuId }: TargetInput) {
  if (!state.resources.has(menuId)) {
    return false;
  }
  if (state.getAttached() === menuId) {
    state.attach(null, null);
  }
  return state.resources.delete(menuId);
}

export function insert(
  state: State,
  { menuId, parentId, index, item }: z.output<typeof insertSchema>,
) {
  const items = structuredClone(state.requireMenu(menuId));
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
  // Revalidate descendants and IDs before committing the complete candidate.
  siblings.splice(index, 0, item);
  return state.commit(menuId, items);
}

export function removeItem(
  state: State,
  { menuId, itemId }: z.output<typeof itemTargetSchema>,
) {
  const items = structuredClone(state.requireMenu(menuId));
  const found = locate(items, itemId) ?? invalid("Menu item does not exist.");
  found.siblings.splice(found.index, 1);
  return state.commit(menuId, items);
}

export function updateItem(
  state: State,
  { menuId, itemId, changes }: z.output<typeof updateItemSchema>,
) {
  const items = structuredClone(state.requireMenu(menuId));
  const found = locate(items, itemId) ?? invalid("Menu item does not exist.");
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
  return state.commit(menuId, items);
}

export function setTrayMenu(
  state: State,
  {
    menuId,
  }: {
    menuId: string | null;
  },
): null {
  state.attach(menuId, menuId === null ? null : state.requireMenu(menuId));
  return null;
}

export function getTrayMenu(state: State) {
  return state.getAttached();
}

export function waitForClick(state: State, signal?: AbortSignal) {
  return state.clicks.wait(signal);
}

export function dispose(state: State): void {
  state.dispose();
}
