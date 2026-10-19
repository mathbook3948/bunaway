import { expect, test } from "bun:test";
import { MacosTray } from "#plugins/tray/src/platforms/macos";
import {
  createStatusItem,
  type StatusItemBinding,
} from "#plugins/tray/src/platforms/macos-status-item";

/** Creates real AppKit status items and keeps the latest binding so the test can read AppKit back. */
function realTray() {
  const bindings: StatusItemBinding[] = [];
  const tray = new MacosTray((onSelect) => {
    const binding = createStatusItem(onSelect);
    bindings.push(binding);
    return binding;
  });
  return {
    tray,
    binding: () => {
      const latest = bindings.at(-1);
      if (!latest) {
        throw new Error("No status item was created.");
      }
      return latest;
    },
  };
}

test.skipIf(
  process.platform !== "darwin" || process.env.BUNAWAY_TRAY_NATIVE !== "1",
)(
  "real NSStatusItem title, tooltip, menu selection, replacement and removal",
  async () => {
    const { tray, binding } = realTray();
    try {
      expect(tray.create("Bunaway 한글 😀", "Tooltip 한글")).toEqual({
        id: "main",
        title: "Bunaway 한글 😀",
        tooltip: "Tooltip 한글",
        hasMenu: false,
      });
      expect(binding().readBack()).toEqual({
        title: "Bunaway 한글 😀",
        tooltip: "Tooltip 한글",
        menu: null,
      });

      tray.setTitle("");
      tray.setTooltip("Next");
      expect(binding().readBack()).toMatchObject({
        title: "",
        tooltip: "Next",
      });

      tray.setMenu([
        {
          type: "item",
          id: "open",
          label: "Open 한글",
          enabled: true,
        },
        {
          type: "separator",
        },
        {
          type: "item",
          id: "quit",
          label: "Quit",
          enabled: false,
        },
      ]);
      expect(tray.get()?.hasMenu).toBe(true);
      expect(binding().readBack().menu).toEqual([
        {
          separator: false,
          title: "Open 한글",
          enabled: true,
        },
        {
          separator: true,
          title: "",
          // AppKit reports a separator item as not enabled.
          enabled: false,
        },
        {
          separator: false,
          title: "Quit",
          enabled: false,
        },
      ]);

      // AppKit's own action dispatch reaches the runtime-registered target and the waiter.
      const chosen = tray.waitForMenuClick();
      binding().activate(0);
      expect(await chosen).toEqual({
        id: "open",
      });

      // A replacement menu renumbers tags and detaches the old one.
      tray.setMenu([
        {
          type: "item",
          id: "only",
          label: "Only",
          enabled: true,
        },
      ]);
      expect(binding().readBack().menu).toHaveLength(1);
      const replaced = tray.waitForMenuClick();
      binding().activate(0);
      expect(await replaced).toEqual({
        id: "only",
      });

      tray.setMenu(null);
      expect(binding().readBack().menu).toBeNull();
      expect(tray.get()?.hasMenu).toBe(false);

      // Destroy removes the item, and the same adapter can create a fresh one.
      expect(tray.destroy()).toBeNull();
      expect(tray.get()).toBeNull();
      expect(tray.create("Again", "").title).toBe("Again");
      expect(binding().readBack().title).toBe("Again");
    } finally {
      tray.dispose();
    }
    expect(tray.get()).toBeNull();
  },
);
