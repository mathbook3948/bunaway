import { dlopen } from "bun:ffi";
import { expect, setDefaultTimeout, test } from "bun:test";
import { deadline } from "../fixtures/deadlines.ts";

setDefaultTimeout(deadline("build"));

const GW_HWNDNEXT = 2;
const MAX_WINDOWS = 4096;

test.skipIf(process.platform !== "win32")(
  "moveTop and moveToBottom reorder real top-level windows once without changing foreground, visibility or topmost state",
  async () => {
    const { Windows } = await import("#native/windows/bun/win32");
    const windows = new Windows(() => {});
    const user = dlopen("user32.dll", {
      GetWindow: {
        args: [
          "u64",
          "u32",
        ],
        returns: "u64",
      },
      GetForegroundWindow: {
        args: [],
        returns: "u64",
      },
    });
    /** Whether `upper` is in front of `lower` in the top-level Z order. */
    const isAbove = (upper: bigint, lower: bigint): boolean => {
      let current = user.symbols.GetWindow(upper, GW_HWNDNEXT);
      for (let step = 0; current !== 0n && step < MAX_WINDOWS; step++) {
        if (current === lower) {
          return true;
        }
        current = user.symbols.GetWindow(current, GW_HWNDNEXT);
      }
      return false;
    };
    const created: bigint[] = [];
    const open = (title: string): bigint => {
      const hwnd = windows.create(title, 320, 240, () => {}, false);
      created.push(hwnd);
      windows.showInactive(hwnd);
      windows.pump();
      return hwnd;
    };
    try {
      const first = open("Z order first");
      const second = open("Z order second");
      const third = open("Z order third");
      const foreground = user.symbols.GetForegroundWindow();
      const boundsBefore = windows.getBounds(third, "outer");

      windows.moveToBottom(third);
      windows.pump();
      expect(isAbove(first, third)).toBe(true);
      expect(isAbove(second, third)).toBe(true);

      windows.moveTop(third);
      windows.pump();
      expect(isAbove(third, first)).toBe(true);
      expect(isAbove(third, second)).toBe(true);

      windows.moveTop(first);
      windows.pump();
      expect(isAbove(first, third)).toBe(true);
      expect(isAbove(first, second)).toBe(true);

      expect(user.symbols.GetForegroundWindow()).toBe(foreground);
      expect(windows.getBounds(third, "outer")).toEqual(boundsBefore);
      expect(windows.isVisible(third)).toBe(true);
      expect(windows.isAlwaysOnTop(third)).toBe(false);

      // A topmost window keeps its band: it cannot be sent below normal windows.
      windows.setAlwaysOnTop(second, true);
      windows.moveTop(first);
      windows.pump();
      expect(isAbove(second, first)).toBe(true);
      expect(() => windows.moveToBottom(second)).toThrow("Disable alwaysOnTop");
      expect(windows.isAlwaysOnTop(second)).toBe(true);
      windows.moveTop(second);
      expect(windows.isAlwaysOnTop(second)).toBe(true);
      windows.setAlwaysOnTop(second, false);

      // Minimized windows are reordered without being restored.
      windows.minimize(first);
      windows.moveTop(first);
      expect(isAbove(first, third)).toBe(true);
      windows.moveToBottom(first);
      expect(isAbove(third, first)).toBe(true);
      expect(windows.isMinimized(first)).toBe(true);

      // Hidden windows are reordered without being shown.
      windows.show(third, false);
      windows.moveTop(third);
      expect(isAbove(third, second)).toBe(true);
      windows.moveToBottom(third);
      expect(isAbove(second, third)).toBe(true);
      expect(windows.isVisible(third)).toBe(false);
    } finally {
      for (const hwnd of created) {
        windows.destroy(hwnd);
      }
    }
  },
);
