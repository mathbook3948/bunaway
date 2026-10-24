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
} from "#menu/contract";

import {
  type WindowMenuDriver,
  WindowMenus,
} from "#menu/platforms/windows-window-menus";

type ResourceInput = z.output<typeof resourceSchema>;
type TargetInput = z.output<typeof targetSchema>;

function invalid(message: string): never {
  throw new BunawayError({
    code: "INVALID_ARGUMENT",
    message,
  });
}

/** Whether any item in the tree is a role item, at any depth. */
function hasRole(items: readonly NativeMenuItem[]): boolean {
  return items.some((item) =>
    item.type === "submenu"
      ? hasRole(item.items)
      : item.type === "item" && item.role !== undefined,
  );
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
  return initializeMenuOperations(environment, () => {
    if (!environment.menus?.windows) {
      throw new BunawayError({
        code: "UNSUPPORTED",
        message: "Native window menus are unavailable.",
      });
    }
    return new WindowMenus(environment.menus.windows);
  });
}

/** Resource state is shared by the real adapter and tests with an injected native owner. */
export function initializeMenuOperations(
  environment: NativeEnvironment,
  createWindowMenus: () => WindowMenuDriver,
) {
  const resources = new Map<string, NativeMenuItem[]>();
  const clicks = new NativeEventWaiters<z.output<typeof clickedSchema>>(
    MAX_MENU_WAITERS,
  );
  let attached: string | null = null;
  let changed = false;
  let revision = 0;
  let disposed = false;
  let cleanupComplete = false;
  let windowRevision = 0;
  let windowMenus: WindowMenuDriver | undefined;
  const windowAttachments = new Map<
    string,
    {
      menuId: string;
      revision: number;
    }
  >();
  let popup:
    | {
        menuId: string;
        windowId: string;
        controller: AbortController;
      }
    | undefined;
  const driver = () => (windowMenus ??= createWindowMenus());
  const busy = () => {
    throw new BunawayError({
      code: "BUSY",
      message: "Menu resource is attached to another owner.",
    });
  };
  const publish = (
    menuId: string,
    itemId: string,
    source: "tray" | "window" | "context",
    windowId: string | null,
  ) => {
    const payload = {
      menuId,
      itemId,
      source,
      windowId,
    };
    clicks.publish(payload);
    environment.menus?.emit("menu.clicked", payload);
  };
  const cancelPopup = (menuId: string) => {
    if (popup?.menuId === menuId) {
      popup.controller.abort();
    }
  };
  const setWindow = (
    windowId: string,
    menuId: string | null,
    items: NativeMenuItem[] | null,
  ) => {
    if (
      menuId !== null &&
      (attached === menuId ||
        [
          ...windowAttachments,
        ].some(([id, entry]) => id !== windowId && entry.menuId === menuId))
    ) {
      busy();
    }
    const nextRevision = ++windowRevision;
    driver().set(
      windowId,
      items === null ? null : structuredClone(items),
      (itemId) => {
        if (
          !disposed &&
          menuId !== null &&
          windowAttachments.get(windowId)?.revision === nextRevision
        ) {
          publish(menuId, itemId, "window", windowId);
        }
      },
      () => {
        if (windowAttachments.get(windowId)?.revision === nextRevision) {
          windowAttachments.delete(windowId);
        }
      },
    );
    if (menuId === null) {
      windowAttachments.delete(windowId);
    } else {
      windowAttachments.set(windowId, {
        menuId,
        revision: nextRevision,
      });
    }
  };
  const snapshot = (menuId: string, items: NativeMenuItem[]) => ({
    menuId,
    items: structuredClone(items),
  });
  const requireMenu = (menuId: string) =>
    resources.get(menuId) ?? invalid("Menu resource does not exist.");
  /**
   * The tray is not tied to an app window: an editing role would type into whichever app has
   * focus, and a window role has no window to act on.
   */
  const requireTrayItems = (items: readonly NativeMenuItem[] | null) => {
    if (items && hasRole(items)) {
      invalid("Tray menus do not support roles.");
    }
  };
  const attach = (menuId: string | null, items: NativeMenuItem[] | null) => {
    requireTrayItems(items);
    if (
      menuId !== null &&
      [
        ...windowAttachments.values(),
      ].some((entry) => entry.menuId === menuId)
    ) {
      busy();
    }
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
        publish(menuId, itemId, "tray", null);
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
    // Validate before cancelling: a rejected change must leave an open popup untouched.
    if (attached === menuId) {
      requireTrayItems(parsed);
    }
    cancelPopup(menuId);
    if (attached === menuId) {
      attach(menuId, parsed);
    }
    for (const [windowId, entry] of windowAttachments) {
      if (entry.menuId === menuId) {
        setWindow(windowId, menuId, parsed);
      }
    }
    resources.set(menuId, parsed);
    return snapshot(menuId, parsed);
  };
  return {
    resources,
    clicks,
    setWindow,
    /** The app's window; INVALID_ARGUMENT when it is not open. */
    currentWindowId() {
      return driver().current();
    },
    getWindow(windowId: string) {
      driver().validate(windowId);
      return windowAttachments.get(windowId)?.menuId ?? null;
    },
    setWindowVisible(windowId: string, visible: boolean) {
      driver().setVisible(windowId, visible);
    },
    isWindowVisible(windowId: string) {
      return driver().isVisible(windowId);
    },
    setWindowAutoHide(windowId: string, autoHide: boolean) {
      driver().setAutoHide(windowId, autoHide);
    },
    isWindowAutoHide(windowId: string) {
      return driver().isAutoHide(windowId);
    },
    detachResource(menuId: string) {
      cancelPopup(menuId);
      for (const [windowId, entry] of windowAttachments) {
        if (entry.menuId === menuId) {
          setWindow(windowId, null, null);
        }
      }
    },
    showContext(
      {
        menuId,
        windowId,
        x,
        y,
      }: {
        menuId: string;
        windowId: string;
        x: number;
        y: number;
      },
      signal?: AbortSignal,
    ) {
      const items = structuredClone(requireMenu(menuId));
      if (popup) {
        throw new BunawayError({
          code: "BUSY",
          message: "A context menu is already open.",
        });
      }
      const controller = new AbortController();
      const abort = () => controller.abort();
      if (signal?.aborted) {
        abort();
      }
      signal?.addEventListener("abort", abort, {
        once: true,
      });
      popup = {
        menuId,
        windowId,
        controller,
      };
      try {
        const itemId = driver().popup(
          windowId,
          items,
          x,
          y,
          controller.signal,
          signal,
        );
        if (controller.signal.aborted || disposed) {
          throw new BunawayError({
            code: "CANCELLED",
            message: "Menu popup cancelled.",
          });
        }
        if (itemId !== null) {
          publish(menuId, itemId, "context", windowId);
        }
        return itemId;
      } finally {
        popup = undefined;
        signal?.removeEventListener("abort", abort);
      }
    },
    requireMenu,
    attach,
    commit,
    snapshot,
    getAttached: () => attached,
    dispose() {
      if (cleanupComplete) {
        return;
      }
      disposed = true;
      popup?.controller.abort();
      clicks.dispose();
      revision++;
      windowMenus?.dispose();
      windowMenus = undefined;
      windowAttachments.clear();
      resources.clear();
      if (changed) {
        environment.menus?.setTrayMenu(undefined);
        changed = false;
      }
      attached = null;
      cleanupComplete = true;
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
  state.detachResource(menuId);
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
  if (
    changes.icon !== undefined &&
    (old.type === "checkbox" || old.type === "radio")
  ) {
    return invalid("Checkbox and radio items do not support icons.");
  }
  if (old.type === "submenu" && changes.accelerator !== undefined) {
    return invalid("Submenus do not support accelerators.");
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

/** Attach or detach the persistent menu bar of the app's open window. */
export function setWindowMenu(
  state: State,
  {
    menuId,
  }: {
    menuId: string | null;
  },
): null {
  state.setWindow(
    state.currentWindowId(),
    menuId,
    menuId === null ? null : state.requireMenu(menuId),
  );
  return null;
}
