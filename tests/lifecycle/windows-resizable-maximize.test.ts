import { expect, test } from "bun:test";

const WM_SYSCOMMAND = 0x0112;
const WM_NCHITTEST = 0x84;
const SC_SIZE = 0xf000n;
const SC_MAXIMIZE = 0xf030n;
const SC_RESTORE = 0xf120n;
const HTLEFT = 10n;
const HTCLIENT = 1n;
const HTBORDER = 18n;

// Without WS_THICKFRAME a window has no sizing border, so the maximize command and
// maximizable are what remain of user-driven sizing. This sends the real system commands
// that the caption button and the shell send; Snap itself is a shell feature the test
// host cannot drive.
test.skipIf(process.platform !== "win32")(
  "a non-resizable window follows maximizable for the maximize command and exposes no sizing border",
  async () => {
    const [{ Windows }, { dlopen }] = await Promise.all([
      import("#native/windows/bun/win32"),
      import("bun:ffi"),
    ]);
    const messages = dlopen("user32.dll", {
      SendMessageW: {
        args: [
          "u64",
          "u32",
          "u64",
          "i64",
        ],
        returns: "i64",
      },
    });
    const send = (hwnd: bigint, command: bigint) =>
      messages.symbols.SendMessageW(hwnd, WM_SYSCOMMAND, command, 0n);
    const native = new Windows(() => {});
    let hwnd = 0n;
    try {
      hwnd = native.create("Resizable false", 640, 480, () => {}, true, {
        x: 100,
        y: 100,
      });
      const edgeHit = () => {
        const outer = native.getBounds(hwnd, "outer");
        const edge = BigInt(
          ((outer.x + 1) & 0xffff) |
            (((outer.y + Math.floor(outer.height / 2)) & 0xffff) << 16),
        );
        return messages.symbols.SendMessageW(hwnd, WM_NCHITTEST, 0n, edge);
      };
      // Baseline: the resizable frame reports a sizing hit at the same point.
      expect(edgeHit()).toBe(HTLEFT);
      native.setResizable(hwnd, false);
      expect(native.isResizable(hwnd)).toBe(false);
      expect(native.isMaximizable(hwnd)).toBe(true);

      // No sizing border: the same point reports the plain frame, and the app ignores the size command.
      const hit = edgeHit();
      expect(hit === HTBORDER || hit === HTCLIENT).toBe(true);
      const outer = native.getBounds(hwnd, "outer");
      send(hwnd, SC_SIZE);
      expect(native.getBounds(hwnd, "outer")).toEqual(outer);

      // maximizable decides the maximize command, independent of resizable.
      send(hwnd, SC_MAXIMIZE);
      expect(native.isMaximized(hwnd)).toBe(true);
      expect(native.isResizable(hwnd)).toBe(false);
      send(hwnd, SC_RESTORE);
      expect(native.isMaximized(hwnd)).toBe(false);
      expect(native.getBounds(hwnd, "outer")).toEqual(outer);

      native.setMaximizable(hwnd, false);
      send(hwnd, SC_MAXIMIZE);
      expect(native.isMaximized(hwnd)).toBe(false);
      expect(native.getBounds(hwnd, "outer")).toEqual(outer);

      // The programmatic path still maximizes regardless of either setting.
      native.maximize(hwnd);
      expect(native.isMaximized(hwnd)).toBe(true);
      native.unmaximize(hwnd);
      expect(native.isMaximized(hwnd)).toBe(false);
    } finally {
      if (hwnd !== 0n) {
        native.destroy(hwnd);
      }
      native.dispose();
      messages.close();
    }
  },
);
