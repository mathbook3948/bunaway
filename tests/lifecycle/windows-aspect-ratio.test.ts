import { describe, expect, test } from "bun:test";
import {
  adjustSizingRect as adjustWithTrack,
  type SizingRect,
  type SystemTrackSize,
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
const SM_CXMAXTRACK = 59;
const SM_CYMAXTRACK = 60;
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

const OPEN_TRACK: SystemTrackSize = {
  minWidth: 0,
  minHeight: 0,
  maxWidth: 100000,
  maxHeight: 100000,
};

/** Applies the pure calculation with unrestricted system track sizes unless given. */
function adjustSizingRect(
  rect: SizingRect,
  edge: number,
  ratio: number,
  frame: {
    width: number;
    height: number;
  },
  dpi: number,
  constraints: Parameters<typeof adjustWithTrack>[5],
  track = OPEN_TRACK,
) {
  return adjustWithTrack(rect, edge, ratio, frame, dpi, constraints, track);
}

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

  test("a 16:9 lock stays inside maxHeight after integer rounding", () => {
    const constraints = {
      ...UNCONSTRAINED,
      maxHeight: 1080,
    };
    for (const width of [
      1900,
      1919,
      1920,
      1921,
      2400,
    ]) {
      const result = adjustSizingRect(
        {
          left: 0,
          top: 0,
          right: width,
          bottom: 700,
        },
        WMSZ_RIGHT,
        16 / 9,
        NO_FRAME,
        96,
        constraints,
      );
      const height = result.bottom - result.top;
      const clientWidth = result.right - result.left;
      expect(height).toBeLessThanOrEqual(1080);
      expect(clientWidth).toBeLessThanOrEqual(1920);
      expect(Math.abs(clientWidth / height - 16 / 9)).toBeLessThan(0.01);
    }
    // An axis lead of 1921 rounds down to 1920x1080 instead of 1921x1081.
    expect(
      adjustSizingRect(
        {
          left: 0,
          top: 0,
          right: 1921,
          bottom: 700,
        },
        WMSZ_RIGHT,
        16 / 9,
        NO_FRAME,
        96,
        constraints,
      ),
    ).toEqual({
      left: 0,
      top: 0,
      right: 1920,
      bottom: 1080,
    });
  });

  test("the minimum wins when user constraints do not overlap the system range", () => {
    // minWidth 2000 exceeds the 800 wide system client maximum, so the width range collapses to 2000
    // and the height stays inside its own range (600), relaxing the ratio.
    expect(
      adjustSizingRect(
        {
          left: 0,
          top: 0,
          right: 1616,
          bottom: 500,
        },
        WMSZ_RIGHT,
        2,
        {
          width: 16,
          height: 39,
        },
        96,
        {
          ...UNCONSTRAINED,
          minWidth: 2000,
        },
        {
          minWidth: 0,
          minHeight: 0,
          maxWidth: 816,
          maxHeight: 639,
        },
      ),
    ).toEqual({
      left: 0,
      top: 0,
      right: 2016,
      bottom: 639,
    });
  });

  test("system track sizes minus the frame narrow the client range", () => {
    const frame = {
      width: 16,
      height: 39,
    };
    // Outer max 816x639 leaves a 800x600 client; width 1600 is pulled back to 800 and height 400.
    expect(
      adjustSizingRect(
        {
          left: 0,
          top: 0,
          right: 1616,
          bottom: 500,
        },
        WMSZ_RIGHT,
        2,
        frame,
        96,
        UNCONSTRAINED,
        {
          minWidth: 0,
          minHeight: 0,
          maxWidth: 816,
          maxHeight: 639,
        },
      ),
    ).toEqual({
      left: 0,
      top: 0,
      right: 816,
      bottom: 439,
    });
    // System minimum outer height 239 means client height >= 200, so width is raised to 400.
    expect(
      adjustSizingRect(
        {
          left: 0,
          top: 0,
          right: 216,
          bottom: 100,
        },
        WMSZ_RIGHT,
        2,
        frame,
        96,
        UNCONSTRAINED,
        {
          ...OPEN_TRACK,
          minHeight: 239,
        },
      ),
    ).toEqual({
      left: 0,
      top: 0,
      right: 416,
      bottom: 239,
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

      // Unlocked: an off-ratio rectangle comes back unchanged.
      expect(
        sizing(
          WMSZ_RIGHT,
          [
            0,
            0,
            800,
            600,
          ],
        ).rect,
      ).toEqual([
        0,
        0,
        800,
        600,
      ]);

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

      // An axis beyond the system maximum track size is pulled back so that
      // WM_GETMINMAXINFO does not silently break the ratio afterwards.
      native.setSizeConstraints(hwnd, {
        minWidth: null,
        minHeight: null,
        maxWidth: null,
        maxHeight: null,
      });
      const maxTrackWidth = user.symbols.GetSystemMetricsForDpi(
        SM_CXMAXTRACK,
        dpi,
      );
      const maxTrackHeight = user.symbols.GetSystemMetricsForDpi(
        SM_CYMAXTRACK,
        dpi,
      );
      const widthOverflow = clientOf(
        sizing(WMSZ_RIGHT, [
          0,
          0,
          maxTrackWidth + 5000,
          500 + frame.height,
        ]).rect,
      );
      expect(widthOverflow.width).toBeLessThanOrEqual(
        maxTrackWidth - frame.width,
      );
      expect(
        Math.abs(widthOverflow.width - widthOverflow.height * 2),
      ).toBeLessThanOrEqual(1);
      const heightOverflow = clientOf(
        sizing(WMSZ_BOTTOM, [
          0,
          0,
          500 + frame.width,
          maxTrackHeight + 5000,
        ]).rect,
      );
      expect(heightOverflow.height).toBeLessThanOrEqual(
        maxTrackHeight - frame.height,
      );
      expect(
        Math.abs(heightOverflow.width - heightOverflow.height * 2),
      ).toBeLessThanOrEqual(1);

      native.setAspectRatio(hwnd, null);
      expect(native.getAspectRatio(hwnd)).toBeNull();
      // Released after a lock: the same off-ratio rectangle is left alone.
      expect(
        sizing(
          WMSZ_RIGHT,
          [
            0,
            0,
            800,
            600,
          ],
        ).rect,
      ).toEqual([
        0,
        0,
        800,
        600,
      ]);
      expect(() => native.setAspectRatio(hwnd, 0)).toThrow();
    } finally {
      if (hwnd && user.symbols.IsWindow(hwnd)) {
        native.destroy(hwnd);
      }
      native.dispose();
      messages.close();
    }
  },
);
