import { dlopen, ptr } from "bun:ffi";
import { expect, test } from "bun:test";
import type { NativeTrayWindowHost } from "@bunaway/plugin-api/native";
import { menuItemsSchema } from "#plugins/menu/src/contract";

const POPUP_CLASS = "#32768";
/** Longest a popup may stay open before the test aborts it, covering slow Windows runners. */
const OPEN_DURATION_MS = 400;
const POSITION = {
  x: 120,
  y: 140,
};
const MENU_ITEMS = menuItemsSchema.parse([
  {
    id: "first",
    type: "item",
    label: "First",
  },
  {
    id: "second",
    type: "item",
    label: "Second",
  },
]);

test.skipIf(process.platform !== "win32")(
  "actual tray popup opens the attached menu at a screen position, closes on abort and rejects misuse",
  async () => {
    const { Windows } = await import("#native/windows/bun/win32");
    const { Tray } = await import("#plugins/tray/src/platforms/windows-tray");
    const user = dlopen("user32.dll", {
      FindWindowW: {
        args: [
          "ptr",
          "ptr",
        ],
        returns: "u64",
      },
      FindWindowExW: {
        args: [
          "u64",
          "u64",
          "ptr",
          "ptr",
        ],
        returns: "u64",
      },
      IsWindowVisible: {
        args: [
          "u64",
        ],
        returns: "i32",
      },
      GetWindowRect: {
        args: [
          "u64",
          "ptr",
        ],
        returns: "i32",
      },
    });
    const popupClass = Buffer.from(`${POPUP_CLASS}\0`, "utf16le");
    /** Screen rectangle of the open native menu, or null when none is shown. */
    const openMenuRect = () => {
      // Other hidden windows share the menu class, so only a visible one is the open popup.
      let hwnd = 0n;
      for (;;) {
        hwnd = BigInt(
          user.symbols.FindWindowExW(0n, hwnd, ptr(popupClass), null),
        );
        if (!hwnd) {
          return null;
        }
        if (user.symbols.IsWindowVisible(hwnd)) {
          break;
        }
      }
      const rect = new Int32Array(4);
      return user.symbols.GetWindowRect(hwnd, ptr(rect))
        ? {
            left: rect[0] ?? 0,
            top: rect[1] ?? 0,
            right: rect[2] ?? 0,
            bottom: rect[3] ?? 0,
          }
        : null;
    };
    // Window messages reach this hook while Windows owns the menu loop, standing in for the
    // host's channel polling. It observes the loop and then fires the registered interrupts.
    const interrupts = new Set<() => void>();
    let openedAt: number | undefined;
    let onPoll: (() => void) | undefined;
    const windows = new Windows(
      () => {},
      undefined,
      undefined,
      () => {
        onPoll?.();
        openedAt ??= performance.now();
        if (performance.now() - openedAt >= OPEN_DURATION_MS) {
          for (const cancel of [
            ...interrupts,
          ]) {
            cancel();
          }
        }
      },
    );
    const host: NativeTrayWindowHost = {
      get icon() {
        return windows.icon;
      },
      create: (title, width, height, receive, visible) =>
        windows.create(title, width, height, receive, visible),
      destroy: (hwnd) => windows.destroy(hwnd),
      interrupt(_signal, cancel) {
        interrupts.add(cancel);
        return () => {
          interrupts.delete(cancel);
        };
      },
    };
    const selections: string[] = [];
    const tray = new Tray(host, "popup", () => {});
    const abortSignal = () => new AbortController().signal;
    const rejection = (run: () => void) => {
      try {
        run();
      } catch (error) {
        return error;
      }
      return undefined;
    };
    try {
      // No attached menu: the host's default Open/Quit menu and a suppressed menu both reject.
      expect(
        rejection(() => tray.popUpContextMenu(POSITION, abortSignal())),
      ).toMatchObject({
        code: "INVALID_ARGUMENT",
      });
      tray.setMenu(null);
      expect(
        rejection(() => tray.popUpContextMenu(null, abortSignal())),
      ).toMatchObject({
        code: "INVALID_ARGUMENT",
      });

      tray.setMenu(MENU_ITEMS, (itemId) => selections.push(itemId));

      // An already aborted signal never shows a menu.
      const aborted = new AbortController();
      aborted.abort();
      let shown = false;
      onPoll = () => {
        shown = true;
      };
      expect(
        rejection(() => tray.popUpContextMenu(POSITION, aborted.signal)),
      ).toMatchObject({
        code: "CANCELLED",
      });
      expect(shown).toBe(false);

      // Open at the position; a second call during the open menu is rejected and the
      // interrupt closes the first without reporting a selection.
      const observed: {
        rect: ReturnType<typeof openMenuRect>;
        nested: unknown;
      } = {
        rect: null,
        nested: undefined,
      };
      onPoll = () => {
        observed.rect ??= openMenuRect();
        observed.nested ??= rejection(() =>
          tray.popUpContextMenu(POSITION, abortSignal()),
        );
      };
      openedAt = undefined;
      expect(
        rejection(() => tray.popUpContextMenu(POSITION, abortSignal())),
      ).toMatchObject({
        code: "CANCELLED",
      });
      onPoll = undefined;
      expect(observed.nested).toMatchObject({
        code: "BUSY",
      });
      console.log(
        "POPUP_RECT",
        JSON.stringify({
          rect: observed.rect,
          at: POSITION,
        }),
      );
      expect(observed.rect).not.toBeNull();
      // The OS may shift a menu to fit the screen, so allow a small margin around the origin.
      expect(
        Math.abs((observed.rect?.left ?? 0) - POSITION.x),
      ).toBeLessThanOrEqual(8);
      expect(
        Math.abs((observed.rect?.top ?? 0) - POSITION.y),
      ).toBeLessThanOrEqual(8);
      expect(selections).toEqual([]);
      expect(interrupts.size).toBe(0);
      expect(openMenuRect()).toBeNull();

      // The closed popup leaves the tray reusable, and an off-screen position is corrected by the OS.
      openedAt = undefined;
      expect(
        rejection(() =>
          tray.popUpContextMenu(
            {
              x: -100000,
              y: 100000,
            },
            abortSignal(),
          ),
        ),
      ).toMatchObject({
        code: "CANCELLED",
      });
      expect(selections).toEqual([]);
    } finally {
      try {
        tray.dispose();
      } finally {
        windows.dispose();
        user.close();
      }
    }
  },
);
