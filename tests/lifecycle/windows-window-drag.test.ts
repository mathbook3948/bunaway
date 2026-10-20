import { describe, expect, test } from "bun:test";
import type { WindowSizeConstraints } from "@bunaway/plugin-api/native";
import {
  resizeIsPinned,
  screenPointParam,
} from "#native/windows/bun/window-drag";
import { waitFor } from "../fixtures/deadlines.ts";

const OPEN: WindowSizeConstraints = {
  minWidth: null,
  minHeight: null,
  maxWidth: null,
  maxHeight: null,
};

describe("drag helpers (pure)", () => {
  test("screen points pack into a zero-extended WM_NCLBUTTONDOWN lParam", () => {
    expect(screenPointParam(10, 20)).toBe((20n << 16n) | 10n);
    // Negative coordinates on monitors left of or above the primary keep their 16-bit two's complement.
    expect(screenPointParam(-1, -2)).toBe(0xfffeffffn);
    expect(screenPointParam(-1920, 5)).toBe((5n << 16n) | 0xf880n);
    expect(screenPointParam(0, 0)).toBe(0n);
  });

  test("a resize is pinned only when every axis it changes has equal limits", () => {
    const widthFixed = {
      ...OPEN,
      minWidth: 300,
      maxWidth: 300,
    };
    const heightFixed = {
      ...OPEN,
      minHeight: 200,
      maxHeight: 200,
    };
    const bothFixed = {
      minWidth: 300,
      maxWidth: 300,
      minHeight: 200,
      maxHeight: 200,
    };
    for (const direction of [
      "north",
      "south",
      "east",
      "west",
      "northEast",
      "northWest",
      "southEast",
      "southWest",
    ] as const) {
      expect(resizeIsPinned(direction, OPEN)).toBe(false);
      expect(resizeIsPinned(direction, bothFixed)).toBe(true);
    }
    expect(resizeIsPinned("east", widthFixed)).toBe(true);
    expect(resizeIsPinned("west", widthFixed)).toBe(true);
    expect(resizeIsPinned("north", widthFixed)).toBe(false);
    expect(resizeIsPinned("southEast", widthFixed)).toBe(false);
    expect(resizeIsPinned("north", heightFixed)).toBe(true);
    expect(resizeIsPinned("south", heightFixed)).toBe(true);
    expect(resizeIsPinned("east", heightFixed)).toBe(false);
    expect(resizeIsPinned("northWest", heightFixed)).toBe(false);
    // A bound on one side only does not pin the axis.
    expect(
      resizeIsPinned("east", {
        ...OPEN,
        minWidth: 300,
      }),
    ).toBe(false);
  });
});

const WM_NCLBUTTONDOWN = 0x00a1;
const PM_REMOVE = 0x0001;
const MOUSEEVENTF_LEFTDOWN = 0x0002;
const MOUSEEVENTF_LEFTUP = 0x0004;
const HIT_TESTS = {
  west: 10n,
  east: 11n,
  north: 12n,
  northWest: 13n,
  northEast: 14n,
  south: 15n,
  southWest: 16n,
  southEast: 17n,
} as const;

test.skipIf(process.platform !== "win32")(
  "real HWND posts the non-client press only for a held button and a draggable window",
  async () => {
    const [{ Windows }, { user }, { dlopen, ptr }, { monitorServices }] =
      await Promise.all([
        import("#native/windows/bun/win32"),
        import("#native/windows/bun/win32-bindings"),
        import("bun:ffi"),
        import("#native/windows/bun/monitors"),
      ]);
    const input = dlopen("user32.dll", {
      SetCursorPos: {
        args: [
          "i32",
          "i32",
        ],
        returns: "i32",
      },
      mouse_event: {
        args: [
          "u32",
          "u32",
          "u32",
          "u32",
          "u64",
        ],
        returns: "void",
      },
    });
    const native = new Windows(() => {});
    const hwnds: bigint[] = [];
    let held = false;
    const press = async () => {
      // Keep the pointer off the test window so the system does not turn the press into its own caption message.
      input.symbols.SetCursorPos(10, 10);
      input.symbols.mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0n);
      held = true;
      // The synthesized press reaches the asynchronous key state a moment later.
      await waitFor(() => !!(user.symbols.GetAsyncKeyState(0x01) & 0x8000), {
        deadline: "inProcess",
        what: "the synthesized left button to appear in the key state",
      });
    };
    const release = () => {
      if (held) {
        input.symbols.mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0n);
        held = false;
      }
    };
    /** Takes the press off the thread queue without dispatching it, so no move or size loop starts. */
    const takePosted = (hwnd: bigint) => {
      const msg = Buffer.alloc(48);
      const found = user.symbols.PeekMessageW(
        ptr(msg),
        hwnd,
        WM_NCLBUTTONDOWN,
        WM_NCLBUTTONDOWN,
        PM_REMOVE,
      );
      return found
        ? {
            wparam: msg.readBigUInt64LE(16),
            lparam: msg.readBigUInt64LE(24),
          }
        : null;
    };
    const rejects = (action: () => void, text: string) => {
      let caught: unknown;
      try {
        action();
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({
        code: "INVALID_ARGUMENT",
        message: expect.stringContaining(text),
      });
    };
    const create = (
      title: string,
      options: Parameters<typeof native.create>[5] = {},
    ) => {
      const hwnd = native.create(title, 640, 480, () => {}, true, {
        x: 100,
        y: 100,
        ...options,
      });
      hwnds.push(hwnd);
      return hwnd;
    };
    try {
      const hwnd = create("Drag");

      // Without a held button the system loop would wait for a click that never comes.
      rejects(() => native.startDragging(hwnd), "not pressed");
      rejects(() => native.startResizeDragging(hwnd, "east"), "not pressed");
      expect(takePosted(hwnd)).toBeNull();

      await press();
      const cursor = monitorServices.cursor();
      const expectedPoint = screenPointParam(cursor.x, cursor.y);
      native.startDragging(hwnd);
      expect(takePosted(hwnd)).toEqual({
        wparam: 2n,
        lparam: expectedPoint,
      });
      for (const [direction, hit] of Object.entries(HIT_TESTS)) {
        native.startResizeDragging(hwnd, direction as keyof typeof HIT_TESTS);
        expect(takePosted(hwnd)).toEqual({
          wparam: hit,
          lparam: expectedPoint,
        });
      }

      // Movement and resizing policy are honored, not bypassed by the programmatic entry.
      native.setMovable(hwnd, false);
      rejects(() => native.startDragging(hwnd), "not movable");
      native.startResizeDragging(hwnd, "east");
      expect(takePosted(hwnd)?.wparam).toBe(11n);
      native.setMovable(hwnd, true);
      native.setResizable(hwnd, false);
      rejects(() => native.startResizeDragging(hwnd, "east"), "not resizable");
      native.startDragging(hwnd);
      expect(takePosted(hwnd)?.wparam).toBe(2n);
      native.setResizable(hwnd, true);

      // Equal limits on the axes a direction changes leave nothing to resize.
      native.setSizeConstraints(hwnd, {
        minWidth: 400,
        maxWidth: 400,
        minHeight: null,
        maxHeight: null,
      });
      rejects(() => native.startResizeDragging(hwnd, "west"), "nothing");
      native.startResizeDragging(hwnd, "south");
      expect(takePosted(hwnd)?.wparam).toBe(15n);
      native.setSizeConstraints(hwnd, OPEN);

      // Minimized, maximized and fullscreen windows have no loop to enter.
      native.maximize(hwnd);
      rejects(() => native.startDragging(hwnd), "Restore");
      rejects(() => native.startResizeDragging(hwnd, "north"), "Restore");
      native.unmaximize(hwnd);
      native.minimize(hwnd);
      rejects(() => native.startDragging(hwnd), "Restore");
      native.restore(hwnd);
      native.setFullscreen(hwnd, true);
      rejects(() => native.startDragging(hwnd), "Restore");
      native.setFullscreen(hwnd, false);
      expect(takePosted(hwnd)).toBeNull();
      native.startDragging(hwnd);
      expect(takePosted(hwnd)?.wparam).toBe(2n);

      release();
      rejects(() => native.startDragging(hwnd), "not pressed");
    } finally {
      release();
      for (const hwnd of hwnds) {
        if (user.symbols.IsWindow(hwnd)) {
          native.destroy(hwnd);
        }
      }
      native.dispose();
      input.close();
    }
  },
);
