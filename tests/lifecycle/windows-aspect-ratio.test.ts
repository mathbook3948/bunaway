import { describe, expect, test } from "bun:test";
import {
  adjustSizingRect,
  WMSZ_BOTTOM,
  WMSZ_BOTTOMLEFT,
  WMSZ_BOTTOMRIGHT,
  WMSZ_LEFT,
  WMSZ_RIGHT,
  WMSZ_TOP,
  WMSZ_TOPLEFT,
  WMSZ_TOPRIGHT,
} from "#native/windows/bun/aspect-ratio";

const WM_SIZING = 0x0214;
const NO_FRAME = {
  width: 0,
  height: 0,
};
const UNCONSTRAINED = {
  minWidth: null,
  minHeight: null,
  maxWidth: null,
  maxHeight: null,
};

describe("adjustSizingRect (pure)", () => {
  const rect = {
    left: 100,
    top: 100,
    right: 500,
    bottom: 400,
  };

  test("side edges lead with width and move the bottom", () => {
    expect(
      adjustSizingRect(rect, WMSZ_RIGHT, 2, NO_FRAME, 96, UNCONSTRAINED),
    ).toEqual({
      left: 100,
      top: 100,
      right: 500,
      bottom: 300,
    });
    expect(
      adjustSizingRect(rect, WMSZ_LEFT, 2, NO_FRAME, 96, UNCONSTRAINED),
    ).toEqual({
      left: 100,
      top: 100,
      right: 500,
      bottom: 300,
    });
  });

  test("top and bottom edges lead with height and move the right side", () => {
    expect(
      adjustSizingRect(rect, WMSZ_BOTTOM, 2, NO_FRAME, 96, UNCONSTRAINED),
    ).toEqual({
      left: 100,
      top: 100,
      right: 700,
      bottom: 400,
    });
    expect(
      adjustSizingRect(rect, WMSZ_TOP, 2, NO_FRAME, 96, UNCONSTRAINED),
    ).toEqual({
      left: 100,
      top: 100,
      right: 700,
      bottom: 400,
    });
  });

  test("corners keep the opposite corner fixed and grow the window", () => {
    // 400x300 is narrower than ratio 2 (needs 600x300), so height leads and width grows.
    expect(
      adjustSizingRect(rect, WMSZ_BOTTOMRIGHT, 2, NO_FRAME, 96, UNCONSTRAINED),
    ).toEqual({
      left: 100,
      top: 100,
      right: 700,
      bottom: 400,
    });
    expect(
      adjustSizingRect(rect, WMSZ_TOPLEFT, 2, NO_FRAME, 96, UNCONSTRAINED),
    ).toEqual({
      left: -100,
      top: 100,
      right: 500,
      bottom: 400,
    });
    // 400x300 is wider than ratio 0.5 (needs 400x800), so width leads and height grows.
    expect(
      adjustSizingRect(rect, WMSZ_TOPRIGHT, 0.5, NO_FRAME, 96, UNCONSTRAINED),
    ).toEqual({
      left: 100,
      top: -400,
      right: 500,
      bottom: 400,
    });
    expect(
      adjustSizingRect(rect, WMSZ_BOTTOMLEFT, 0.5, NO_FRAME, 96, UNCONSTRAINED),
    ).toEqual({
      left: 100,
      top: 100,
      right: 500,
      bottom: 900,
    });
  });

  test("the ratio applies to the client area, excluding the frame", () => {
    const frame = {
      width: 16,
      height: 39,
    };
    // Client 384x261 -> width leads, height = 192 -> outer 400x231.
    expect(
      adjustSizingRect(rect, WMSZ_RIGHT, 2, frame, 96, UNCONSTRAINED),
    ).toEqual({
      left: 100,
      top: 100,
      right: 500,
      bottom: 331,
    });
  });

  test("constraints are logical client sizes converted by DPI and win over the ratio", () => {
    // minHeight 200 logical = 300 physical at 144 DPI, so width 400 -> height 200 is raised.
    expect(
      adjustSizingRect(rect, WMSZ_RIGHT, 2, NO_FRAME, 144, {
        ...UNCONSTRAINED,
        minHeight: 200,
      }),
    ).toEqual({
      left: 100,
      top: 100,
      right: 700,
      bottom: 400,
    });
    // Max width 200 logical = 300 physical at 144 DPI caps the leading axis.
    expect(
      adjustSizingRect(rect, WMSZ_RIGHT, 2, NO_FRAME, 144, {
        ...UNCONSTRAINED,
        maxWidth: 200,
      }),
    ).toEqual({
      left: 100,
      top: 100,
      right: 400,
      bottom: 250,
    });
    // Infeasible: width fixed to 300..300 while height must stay >= 300, ratio relaxed.
    expect(
      adjustSizingRect(rect, WMSZ_RIGHT, 2, NO_FRAME, 96, {
        minWidth: 300,
        maxWidth: 300,
        minHeight: 300,
        maxHeight: null,
      }),
    ).toEqual({
      left: 100,
      top: 100,
      right: 400,
      bottom: 400,
    });
  });
});

test.skipIf(process.platform !== "win32")(
  "real HWND rewrites a synthesized WM_SIZING RECT per edge and releases on null",
  async () => {
    const [{ Windows }, { user }, { dlopen, ptr }] = await Promise.all([
      import("#native/windows/bun/win32"),
      import("#native/windows/bun/win32-bindings"),
      import("bun:ffi"),
    ]);
    const messages = dlopen("user32.dll", {
      SendMessageW: {
        args: [
          "u64",
          "u32",
          "u64",
          "ptr",
        ],
        returns: "i64",
      },
    });
    const native = new Windows(() => {});
    let hwnd = 0n;
    const sizing = (
      edge: number,
      bounds: [
        number,
        number,
        number,
        number,
      ],
    ) => {
      const buffer = new Int32Array(bounds);
      const result = messages.symbols.SendMessageW(
        hwnd,
        WM_SIZING,
        BigInt(edge),
        ptr(buffer),
      );
      return {
        handled: result === 1n,
        rect: Array.from(buffer),
      };
    };
    try {
      hwnd = native.create("Aspect ratio", 640, 480, () => {}, false, {
        x: 100,
        y: 100,
      });
      expect(native.getAspectRatio(hwnd)).toBeNull();
      const before = native.getBounds(hwnd, "outer");

      // Unlocked: Windows default handling leaves the rectangle alone.
      expect(
        sizing(
          WMSZ_RIGHT,
          [
            0,
            0,
            800,
            600,
          ],
        ),
      ).toEqual({
        handled: false,
        rect: [
          0,
          0,
          800,
          600,
        ],
      });

      native.setAspectRatio(hwnd, 2);
      expect(native.getAspectRatio(hwnd)).toBe(2);
      // Setting a ratio does not resize the current window.
      expect(native.getBounds(hwnd, "outer")).toEqual(before);

      const dpi = native.getDpi(hwnd);
      const frame = {
        width: before.width - native.getBounds(hwnd, "content").width,
        height: before.height - native.getBounds(hwnd, "content").height,
      };
      const clientOf = (rect: number[]) => ({
        width: (rect[2] ?? 0) - (rect[0] ?? 0) - frame.width,
        height: (rect[3] ?? 0) - (rect[1] ?? 0) - frame.height,
      });
      for (const edge of [
        WMSZ_LEFT,
        WMSZ_RIGHT,
        WMSZ_TOP,
        WMSZ_BOTTOM,
        WMSZ_TOPLEFT,
        WMSZ_TOPRIGHT,
        WMSZ_BOTTOMLEFT,
        WMSZ_BOTTOMRIGHT,
      ]) {
        const result = sizing(edge, [
          0,
          0,
          800 + frame.width,
          500 + frame.height,
        ]);
        expect(result.handled).toBe(true);
        const client = clientOf(result.rect);
        // Rounding may leave a one pixel remainder on the derived axis.
        expect(Math.abs(client.width - client.height * 2)).toBeLessThanOrEqual(
          1,
        );
      }

      // Existing size constraints (logical) still bound the result.
      native.setSizeConstraints(hwnd, {
        minWidth: null,
        minHeight: null,
        maxWidth: 400,
        maxHeight: null,
      });
      const capped = clientOf(
        sizing(WMSZ_RIGHT, [
          0,
          0,
          2000,
          500 + frame.height,
        ]).rect,
      );
      expect(capped.width).toBe(Math.round((400 * dpi) / 96));
      expect(Math.abs(capped.width - capped.height * 2)).toBeLessThanOrEqual(1);

      native.setAspectRatio(hwnd, null);
      expect(native.getAspectRatio(hwnd)).toBeNull();
      expect(
        sizing(
          WMSZ_RIGHT,
          [
            0,
            0,
            800,
            600,
          ],
        ),
      ).toEqual({
        handled: false,
        rect: [
          0,
          0,
          800,
          600,
        ],
      });
      expect(() => native.setAspectRatio(hwnd, 0)).toThrow();
    } finally {
      if (hwnd && user.symbols.IsWindow(hwnd)) {
        native.destroy(hwnd);
      }
    }
  },
);
