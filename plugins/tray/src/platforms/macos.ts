import { NativeEventWaiters } from "@bunaway/plugin";
import { MAX_TRAY_WAITERS } from "@bunaway/plugin-api/native";
import { BunawayError } from "@bunaway/protocol";
import type { z } from "zod";
import type {
  MacosMenuItem,
  MacosStatusItem,
  MacosTrayInstance,
  macosMenuClickSchema,
} from "#tray/contract";
import {
  createStatusItem,
  type NativeMenuEntry,
  type StatusItemBinding,
} from "#tray/platforms/macos-status-item";

type MenuClick = z.output<typeof macosMenuClickSchema>;
/** Creates the AppKit binding; injectable so tests can observe wiring without a menu bar. */
export type StatusItemFactory = (
  onSelect: (tag: number) => void,
) => StatusItemBinding;

/** The item that exists between `create` and `destroy`, with the state `get` reports. */
type Live = {
  binding: StatusItemBinding;
  title: string;
  tooltip: string;
  /** Item ids by native tag, for the menu currently attached. Null when no menu is attached. */
  menuIds: readonly (string | null)[] | null;
};

/**
 * Owns the app's single menu bar item. The item exists only between `create` and `destroy` or
 * plugin disposal, which also stops any pending menu waits.
 */
export class MacosTray implements MacosTrayInstance {
  private live: Live | undefined;
  private clicks = new NativeEventWaiters<MenuClick>(MAX_TRAY_WAITERS);

  constructor(private readonly createBinding: StatusItemFactory) {}

  private requireLive(): Live {
    if (!this.live) {
      throw new BunawayError({
        code: "UNSUPPORTED",
        message: "No menu bar item exists. Call tray.create first.",
      });
    }
    return this.live;
  }

  private snapshot(live: Live): MacosStatusItem {
    return {
      id: "main",
      title: live.title,
      tooltip: live.tooltip,
      hasMenu: live.menuIds !== null,
    };
  }

  /** Runs on the main thread when AppKit reports a chosen entry; stale tags are ignored. */
  private selected(tag: number): void {
    const id = this.live?.menuIds?.[tag];
    if (id) {
      this.clicks.publish({
        id,
      });
    }
  }

  create(title: string, tooltip: string): MacosStatusItem {
    if (this.live) {
      throw new BunawayError({
        code: "BUSY",
        message: "The menu bar item already exists.",
      });
    }
    const binding = this.createBinding((tag) => this.selected(tag));
    try {
      binding.setTitle(title);
      binding.setTooltip(tooltip);
    } catch (error) {
      binding.dispose();
      throw error;
    }
    this.live = {
      binding,
      title,
      tooltip,
      menuIds: null,
    };
    return this.snapshot(this.live);
  }

  destroy(): null {
    const live = this.live;
    if (live) {
      // Forget the item first so a failing release cannot leave a half-owned state behind.
      this.live = undefined;
      // Waits belong to the item that is going away, and a later item must not inherit them.
      const ended = this.clicks;
      this.clicks = new NativeEventWaiters<MenuClick>(MAX_TRAY_WAITERS);
      ended.dispose();
      live.binding.dispose();
    }
    return null;
  }

  get(): MacosStatusItem | null {
    return this.live ? this.snapshot(this.live) : null;
  }

  setTitle(title: string): null {
    const live = this.requireLive();
    live.binding.setTitle(title);
    live.title = title;
    return null;
  }

  setTooltip(tooltip: string): null {
    const live = this.requireLive();
    live.binding.setTooltip(tooltip);
    live.tooltip = tooltip;
    return null;
  }

  setMenu(menuItems: readonly MacosMenuItem[] | null): null {
    const live = this.requireLive();
    // An empty list has nothing to show, so it removes the menu like null does.
    const items = menuItems && menuItems.length > 0 ? menuItems : null;
    // Tags are positions in the new list; separators have no id and are never reported.
    const ids = items?.map((item) => (item.type === "item" ? item.id : null));
    const entries: NativeMenuEntry[] | null =
      items?.map((item, tag) =>
        item.type === "item"
          ? {
              kind: "item",
              label: item.label,
              enabled: item.enabled,
              tag,
            }
          : {
              kind: "separator",
            },
      ) ?? null;
    live.binding.setMenu(entries);
    live.menuIds = ids ?? null;
    return null;
  }

  waitForMenuClick(signal?: AbortSignal): Promise<MenuClick> {
    this.requireLive();
    return this.clicks.wait(signal);
  }

  dispose(): void {
    // Cancels waits even when no item exists; destroy covers the item's own waits.
    this.clicks.dispose();
    this.destroy();
  }
}

export function initialize(): MacosTray {
  return new MacosTray(createStatusItem);
}

export function dispose(instance: MacosTray): void {
  instance.dispose();
}
