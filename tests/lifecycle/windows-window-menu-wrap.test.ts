import { dlopen, ptr } from "bun:ffi";
import { expect, test } from "bun:test";
import type { NativeMenuWindowHost } from "@bunaway/plugin-api/native";
import { menuItemsSchema } from "#plugins/menu/src/contract";

const SWP_NOMOVE = 0x0002;
const SWP_NOZORDER = 0x0004;
const SWP_NOACTIVATE = 0x0010;
const MENU_HEADINGS = 24;
const MIN = {
  width: 300,
  height: 200,
};
const MAX = {
  width: 500,
  height: 400,
};

test.skipIf(process.platform !== "win32")(
  "a menu bar wrapped onto several rows keeps the content size limits through resizes, minimize and maximize",
  async () => {
    const [{ Windows }, { user }, { WindowMenus }, sizes] = await Promise.all([
      import("#native/windows/bun/win32"),
      import("#native/windows/bun/win32-bindings"),
      import("#plugins/menu/src/platforms/windows-window-menus"),
      import("#native/windows/bun/window-size"),
    ]);
    const native = dlopen("user32.dll", {
      GetMenu: {
        args: [
          "u64",
        ],
        returns: "u64",
      },
      GetMenuItemRect: {
        args: [
          "u64",
          "u64",
          "u32",
          "ptr",
        ],
        returns: "i32",
      },
    });
    const windows = new Windows(() => {});
    const listeners = new Set<
      Parameters<NativeMenuWindowHost["subscribe"]>[1]
    >();
    let hwnd = 0n;
    const host: NativeMenuWindowHost = {
      current: () => "main",
      resolve() {
        if (!hwnd) {
          throw new Error("Window not found");
        }
        return hwnd;
      },
      subscribe(_id, receive) {
        listeners.add(receive);
        return () => {
          listeners.delete(receive);
        };
      },
      interrupt: () => () => {},
      changed() {
        windows.getSnapshot(host.resolve("main"));
      },
      executeRole() {},
    };
    const menus = new WindowMenus(host);
    try {
      hwnd = windows.create(
        "main",
        MAX.width,
        MAX.height,
        (message, wparam, lparam) => {
          for (const receive of [
            ...listeners,
          ]) {
            receive(message, wparam, lparam);
          }
        },
        false,
        {},
      );
      windows.observe(hwnd, "main", () => {});
      menus.set(
        "main",
        menuItemsSchema.parse(
          Array.from(
            {
              length: MENU_HEADINGS,
            },
            (_, index) => ({
              id: `m${index}`,
              type: "submenu",
              label: `Menu heading ${index}`,
              items: [],
            }),
          ),
        ),
        () => {},
        () => {},
      );
      const dpi = windows.getDpi(hwnd);
      const physical = (logical: number) => sizes.physicalPixels(logical, dpi);

      /** Distinct top edges of the menu items, measured from the real HMENU. */
      const menuRows = () => {
        const menu = native.symbols.GetMenu(hwnd);
        expect(menu).not.toBe(0n);
        const tops = new Set<number>();
        const rect = new Int32Array(4);
        for (let index = 0; index < MENU_HEADINGS; index++) {
          expect(
            native.symbols.GetMenuItemRect(hwnd, menu, index, ptr(rect)),
          ).toBe(1);
          tops.add(rect[1] ?? 0);
        }
        return tops.size;
      };
      const client = () => {
        const rect = new Int32Array(4);
        expect(user.symbols.GetClientRect(hwnd, ptr(rect))).toBeTruthy();
        return {
          width: (rect[2] ?? 0) - (rect[0] ?? 0),
          height: (rect[3] ?? 0) - (rect[1] ?? 0),
        };
      };
      const dragOuter = (width: number, height: number) => {
        expect(
          user.symbols.SetWindowPos(
            hwnd,
            0n,
            0,
            0,
            width,
            height,
            SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE,
          ),
        ).toBeTruthy();
      };
      /** A bar that does not wrap would make every assertion below pass for the wrong reason. */
      const expectWrapped = (phase: string) => {
        const rows = menuRows();
        expect(rows, `${phase}: menu bar rows`).toBeGreaterThanOrEqual(2);
        return rows;
      };

      windows.setSizeConstraints(hwnd, {
        minWidth: MIN.width,
        minHeight: MIN.height,
        maxWidth: MAX.width,
        maxHeight: MAX.height,
      });

      // Each phase reports on its own, so one run shows every failing state.
      const failures: string[] = [];
      const phase = (name: string, run: () => void) => {
        try {
          run();
        } catch (error) {
          failures.push(
            `${name}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      };

      // Programmatic sizes are clamped in content pixels, not outer pixels.
      phase("setSize", () => {
        windows.setSize(hwnd, 100, 100);
        expectWrapped("setSize below the minimum");
        expect(client(), "setSize below the minimum").toEqual({
          width: physical(MIN.width),
          height: physical(MIN.height),
        });
        windows.setSize(hwnd, 2000, 2000);
        expectWrapped("setSize above the maximum");
        expect(client(), "setSize above the maximum").toEqual({
          width: physical(MAX.width),
          height: physical(MAX.height),
        });
      });

      // A border drag is clamped by the system through WM_GETMINMAXINFO.
      // The content area must not leave the limits because rows wrapped.
      phase("drag", () => {
        dragOuter(50, 50);
        const rowsAtMinimum = expectWrapped("drag below the minimum");
        const draggedMinimum = client();
        expect(draggedMinimum.width, "drag below the minimum width").toBe(
          physical(MIN.width),
        );
        expect(
          draggedMinimum.height,
          `drag below the minimum height with ${rowsAtMinimum} menu rows`,
        ).toBeGreaterThanOrEqual(physical(MIN.height));
        dragOuter(4000, 4000);
        const rowsAtMaximum = expectWrapped("drag above the maximum");
        const draggedMaximum = client();
        expect(draggedMaximum.width, "drag above the maximum width").toBe(
          physical(MAX.width),
        );
        expect(
          draggedMaximum.height,
          `drag above the maximum height with ${rowsAtMaximum} menu rows`,
        ).toBeLessThanOrEqual(physical(MAX.height));
      });

      // Minimize and maximize, then restore: the same content size and row count return,
      // and the limits still apply afterwards.
      const restoredState = (
        name: string,
        change: () => void,
        undo: () => void,
      ) =>
        phase(name, () => {
          windows.setSize(hwnd, 400, 300);
          const rowsBefore = expectWrapped(`before ${name}`);
          const before = client();
          expect(before, `content before ${name}`).toEqual({
            width: physical(400),
            height: physical(300),
          });
          change();
          undo();
          expect(expectWrapped(`after ${name}`), `rows after ${name}`).toBe(
            rowsBefore,
          );
          expect(client(), `content after ${name}`).toEqual(before);
          windows.setSize(hwnd, 100, 100);
          expect(client(), `setSize after ${name}`).toEqual({
            width: physical(MIN.width),
            height: physical(MIN.height),
          });
        });
      restoredState(
        "minimize",
        () => {
          windows.minimize(hwnd);
          expect(user.symbols.IsIconic(hwnd)).toBeTruthy();
        },
        () => {
          windows.restore(hwnd);
          expect(user.symbols.IsIconic(hwnd)).toBe(0);
        },
      );
      restoredState(
        "maximize",
        () => {
          windows.maximize(hwnd);
          expect(user.symbols.IsZoomed(hwnd)).toBeTruthy();
        },
        () => {
          windows.unmaximize(hwnd);
          expect(user.symbols.IsZoomed(hwnd)).toBe(0);
        },
      );
      expect(failures).toEqual([]);
    } finally {
      menus.dispose();
      if (hwnd) {
        windows.destroy(hwnd);
      }
      windows.dispose();
      native.close();
    }
  },
);
