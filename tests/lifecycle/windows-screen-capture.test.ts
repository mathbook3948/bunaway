import { dlopen, JSCallback, ptr } from "bun:ffi";
import { expect, setDefaultTimeout, test } from "bun:test";
import assert from "node:assert/strict";
import { wide } from "@bunaway/plugin/win32";
import screenCapture from "@bunaway/plugin-screen-capture/native/windows";
import {
  captureOutputSchema,
  sourceListSchema,
} from "#plugins/screen-capture/src/contract";
import { deadline } from "../fixtures/deadlines.ts";
import { decodePng } from "../fixtures/png.ts";

setDefaultTimeout(deadline("build"));

const WS_POPUP = 0x80000000;
const WS_VISIBLE = 0x10000000;
const SW_MINIMIZE = 6;
const WDA_EXCLUDEFROMCAPTURE = 0x11;
const GR_GDIOBJECTS = 0;
const CURRENT_PROCESS = 0xffffffffffffffffn;
const WINDOW_WIDTH = 320;
const WINDOW_HEIGHT = 240;
const FILL = {
  red: 10,
  green: 200,
  blue: 30,
};
const WARM_UP_CAPTURES = 2;
const LEAK_CHECK_CAPTURES = 20;

/** The few user32 and gdi32 calls the test needs to own a window of a known color. */
function openDriver() {
  const user32 = dlopen("user32.dll", {
    CreateWindowExW: {
      args: [
        "u32",
        "ptr",
        "ptr",
        "u32",
        "i32",
        "i32",
        "i32",
        "i32",
        "u64",
        "u64",
        "u64",
        "ptr",
      ],
      returns: "u64",
    },
    DestroyWindow: {
      args: [
        "u64",
      ],
      returns: "i32",
    },
    GetDC: {
      args: [
        "u64",
      ],
      returns: "u64",
    },
    ReleaseDC: {
      args: [
        "u64",
        "u64",
      ],
      returns: "i32",
    },
    FillRect: {
      args: [
        "u64",
        "ptr",
        "u64",
      ],
      returns: "i32",
    },
    ShowWindow: {
      args: [
        "u64",
        "i32",
      ],
      returns: "i32",
    },
    SetWindowDisplayAffinity: {
      args: [
        "u64",
        "u32",
      ],
      returns: "i32",
    },
    RegisterClassExW: {
      args: [
        "ptr",
      ],
      returns: "u16",
    },
    UnregisterClassW: {
      args: [
        "ptr",
        "u64",
      ],
      returns: "i32",
    },
    DefWindowProcW: {
      args: [
        "u64",
        "u32",
        "u64",
        "i64",
      ],
      returns: "i64",
    },
    GetGuiResources: {
      args: [
        "u64",
        "u32",
      ],
      returns: "u32",
    },
  });
  const gdi32 = dlopen("gdi32.dll", {
    CreateSolidBrush: {
      args: [
        "u32",
      ],
      returns: "u64",
    },
    DeleteObject: {
      args: [
        "u64",
      ],
      returns: "i32",
    },
  });
  return {
    user32,
    gdi32,
  };
}

const WNDCLASSEXW_BYTES = 80;
const COLORREF = FILL.red | (FILL.green << 8) | (FILL.blue << 16);

/**
 * A window class whose background is the known color, so the window shows that color whether
 * Windows paints it through the class brush or the test paints it directly. Messages go to
 * DefWindowProcW; the class and its brush are released by `release`.
 */
function registerColoredClass(driver: ReturnType<typeof openDriver>) {
  const name = wide(`BunawayScreenCaptureTest${process.pid}`);
  const brush = driver.gdi32.symbols.CreateSolidBrush(COLORREF);
  const procedure = new JSCallback(
    (window: bigint, message: number, wparam: bigint, lparam: bigint) =>
      driver.user32.symbols.DefWindowProcW(window, message, wparam, lparam),
    {
      args: [
        "u64",
        "u32",
        "u64",
        "i64",
      ],
      returns: "i64",
    },
  );
  const info = Buffer.alloc(WNDCLASSEXW_BYTES);
  info.writeUInt32LE(WNDCLASSEXW_BYTES, 0);
  info.writeBigUInt64LE(BigInt(procedure.ptr as number), 8);
  info.writeBigUInt64LE(brush, 48);
  info.writeBigUInt64LE(BigInt(ptr(name)), 64);
  assert(
    driver.user32.symbols.RegisterClassExW(ptr(info)) !== 0,
    "RegisterClassExW failed.",
  );
  return {
    name,
    release() {
      driver.user32.symbols.UnregisterClassW(ptr(name), 0n);
      procedure.close();
      driver.gdi32.symbols.DeleteObject(brush);
    },
  };
}

/** Create a visible popup of the test process in the colored class and paint it through its own device context. */
function createColoredWindow(
  driver: ReturnType<typeof openDriver>,
  className: Buffer,
  title: string,
): bigint {
  const text = wide(title);
  const window = driver.user32.symbols.CreateWindowExW(
    0,
    ptr(className),
    ptr(text),
    WS_POPUP | WS_VISIBLE,
    200,
    200,
    WINDOW_WIDTH,
    WINDOW_HEIGHT,
    0n,
    0n,
    0n,
    null,
  );
  assert(window !== 0n, "CreateWindowExW failed.");
  const dc = driver.user32.symbols.GetDC(window);
  const brush = driver.gdi32.symbols.CreateSolidBrush(COLORREF);
  const area = Buffer.alloc(16);
  area.writeInt32LE(WINDOW_WIDTH, 8);
  area.writeInt32LE(WINDOW_HEIGHT, 12);
  driver.user32.symbols.FillRect(dc, ptr(area), brush);
  driver.gdi32.symbols.DeleteObject(brush);
  driver.user32.symbols.ReleaseDC(window, dc);
  return window;
}

test.skipIf(process.platform !== "win32")(
  "a window of the test process is listed, captured with its color and released without GDI leaks",
  async () => {
    const platform = screenCapture._definition.nativePlatforms.windows;
    assert(platform);
    const adapter = platform.create({
      dataRoot: ".",
      capabilities: [],
    });
    const driver = openDriver();
    const windows: bigint[] = [];
    const windowClass = registerColoredClass(driver);
    try {
      const title = `bunaway-screen-capture-${process.pid}`;
      const window = createColoredWindow(driver, windowClass.name, title);
      windows.push(window);
      const list = async (types: string[]) => {
        return sourceListSchema.parse(
          await adapter.execute(
            "screenCapture.listSources",
            {
              types,
            },
            "backend",
          ),
        );
      };
      const capture = async (id: string, edge: number) => {
        return captureOutputSchema.parse(
          await adapter.execute(
            "screenCapture.captureSource",
            {
              id,
              maxWidth: edge,
              maxHeight: edge,
            },
            "backend",
          ),
        );
      };

      const sources = await list([
        "window",
      ]);
      const own = sources.find((source) => source.name === title);
      assert(own, "The test window is not listed.");
      expect(own).toMatchObject({
        kind: "window",
        ownedByApp: true,
        minimized: false,
      });
      expect(own.bounds.width).toBeGreaterThan(0);
      expect(own.bounds.height).toBeGreaterThan(0);

      // The full-size capture has the listed size and the color painted into the window.
      const image = await capture(own.id, 4096);
      expect([
        image.width,
        image.height,
      ]).toEqual([
        own.bounds.width,
        own.bounds.height,
      ]);
      const decoded = decodePng(Buffer.from(image.data, "base64"));
      const center =
        (Math.floor(decoded.height / 2) * decoded.width +
          Math.floor(decoded.width / 2)) *
        3;
      console.log(
        `PROBE first capture rgb=${[
          ...decoded.rgb.subarray(center, center + 3),
        ].join(",")}`,
      );
      {
        const u = dlopen("user32.dll", {
          GetDC: {
            args: [
              "u64",
            ],
            returns: "u64",
          },
          ReleaseDC: {
            args: [
              "u64",
              "u64",
            ],
            returns: "i32",
          },
          PrintWindow: {
            args: [
              "u64",
              "u64",
              "u32",
            ],
            returns: "i32",
          },
          IsHungAppWindow: {
            args: [
              "u64",
            ],
            returns: "i32",
          },
          GetSystemMetrics: {
            args: [
              "i32",
            ],
            returns: "i32",
          },
        });
        const g = dlopen("gdi32.dll", {
          GetPixel: {
            args: [
              "u64",
              "i32",
              "i32",
            ],
            returns: "u32",
          },
          CreateCompatibleDC: {
            args: [
              "u64",
            ],
            returns: "u64",
          },
          CreateCompatibleBitmap: {
            args: [
              "u64",
              "i32",
              "i32",
            ],
            returns: "u64",
          },
          SelectObject: {
            args: [
              "u64",
              "u64",
            ],
            returns: "u64",
          },
          DeleteObject: {
            args: [
              "u64",
            ],
            returns: "i32",
          },
          DeleteDC: {
            args: [
              "u64",
            ],
            returns: "i32",
          },
          BitBlt: {
            args: [
              "u64",
              "i32",
              "i32",
              "i32",
              "i32",
              "u64",
              "i32",
              "i32",
              "u32",
            ],
            returns: "i32",
          },
        });
        const hex = (v: number) => v.toString(16).padStart(6, "0");
        const screenDc = u.symbols.GetDC(0n);
        const winDc = u.symbols.GetDC(window);
        const lines: string[] = [];
        lines.push(
          `screen ${u.symbols.GetSystemMetrics(0)}x${u.symbols.GetSystemMetrics(1)} sessionname=${process.env.SESSIONNAME}`,
        );
        lines.push(
          `GetPixel(windowDC)=${hex(g.symbols.GetPixel(winDc, 100, 100))}`,
        );
        lines.push(
          `GetPixel(screenDC)=${hex(g.symbols.GetPixel(screenDc, 300, 300))}`,
        );
        for (const flag of [
          0,
          1,
          2,
          3,
        ]) {
          const mem = g.symbols.CreateCompatibleDC(screenDc);
          const bmp = g.symbols.CreateCompatibleBitmap(
            screenDc,
            WINDOW_WIDTH,
            WINDOW_HEIGHT,
          );
          const old = g.symbols.SelectObject(mem, bmp);
          const ok = u.symbols.PrintWindow(window, mem, flag);
          lines.push(
            `PrintWindow flag=${flag} ok=${ok} pixel=${hex(g.symbols.GetPixel(mem, 100, 100))}`,
          );
          g.symbols.SelectObject(mem, old);
          g.symbols.DeleteObject(bmp);
          g.symbols.DeleteDC(mem);
        }
        const mem2 = g.symbols.CreateCompatibleDC(screenDc);
        const bmp2 = g.symbols.CreateCompatibleBitmap(
          screenDc,
          WINDOW_WIDTH,
          WINDOW_HEIGHT,
        );
        const old2 = g.symbols.SelectObject(mem2, bmp2);
        g.symbols.BitBlt(
          mem2,
          0,
          0,
          WINDOW_WIDTH,
          WINDOW_HEIGHT,
          screenDc,
          200,
          200,
          0x40cc0020,
        );
        lines.push(
          `BitBlt(screen) pixel=${hex(g.symbols.GetPixel(mem2, 100, 100))}`,
        );
        g.symbols.SelectObject(mem2, old2);
        g.symbols.DeleteObject(bmp2);
        g.symbols.DeleteDC(mem2);
        u.symbols.ReleaseDC(window, winDc);
        u.symbols.ReleaseDC(0n, screenDc);
        console.log(
          `PROBE expected=${hex(FILL.red | (FILL.green << 8) | (FILL.blue << 16))} hung=${u.symbols.IsHungAppWindow(window)} ${lines.join(" | ")}`,
        );
      }
      expect([
        ...decoded.rgb.subarray(center, center + 3),
      ]).toEqual([
        FILL.red,
        FILL.green,
        FILL.blue,
      ]);

      // A thumbnail keeps the aspect ratio inside the requested box.
      const thumbnail = await capture(own.id, 64);
      expect(Math.max(thumbnail.width, thumbnail.height)).toBe(64);

      // Every capture frees its device contexts and bitmaps.
      for (let at = 0; at < WARM_UP_CAPTURES; at += 1) {
        await capture(own.id, 128);
      }
      const before = driver.user32.symbols.GetGuiResources(
        CURRENT_PROCESS,
        GR_GDIOBJECTS,
      );
      for (let at = 0; at < LEAK_CHECK_CAPTURES; at += 1) {
        await capture(own.id, 128);
      }
      expect(
        driver.user32.symbols.GetGuiResources(CURRENT_PROCESS, GR_GDIOBJECTS),
      ).toBe(before);

      // Screens report a size and a PNG; their color is not checked because a runner can have a blank desktop.
      const screens = await list([
        "screen",
      ]);
      expect(screens.length).toBeGreaterThan(0);
      const screen = await capture(screens[0]?.id as string, 64);
      expect(Math.max(screen.width, screen.height)).toBeLessThanOrEqual(64);
      expect(decodePng(Buffer.from(screen.data, "base64")).width).toBe(
        screen.width,
      );

      // A protected window refuses a window capture.
      const protectedTitle = `${title}-protected`;
      const hidden = createColoredWindow(
        driver,
        windowClass.name,
        protectedTitle,
      );
      windows.push(hidden);
      expect(
        driver.user32.symbols.SetWindowDisplayAffinity(
          hidden,
          WDA_EXCLUDEFROMCAPTURE,
        ),
      ).toBe(1);
      const protectedSource = (
        await list([
          "window",
        ])
      ).find((source) => source.name === protectedTitle);
      assert(protectedSource, "The protected window is not listed.");
      await expect(capture(protectedSource.id, 64)).rejects.toMatchObject({
        code: "PERMISSION_DENIED",
        details: {
          reason: "SOURCE_PROTECTED",
        },
      });

      // A minimized window is still listed but cannot be captured.
      driver.user32.symbols.ShowWindow(window, SW_MINIMIZE);
      const minimized = (
        await list([
          "window",
        ])
      ).find((source) => source.id === own.id);
      expect(minimized?.minimized).toBe(true);
      await expect(capture(own.id, 64)).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
        details: {
          reason: "SOURCE_UNAVAILABLE",
        },
      });

      // A destroyed window is gone.
      driver.user32.symbols.DestroyWindow(window);
      windows.splice(windows.indexOf(window), 1);
      await expect(capture(own.id, 64)).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
        details: {
          reason: "SOURCE_NOT_FOUND",
        },
      });
      await expect(
        adapter.execute(
          "screenCapture.captureSource",
          {
            id: crypto.randomUUID(),
          },
          "backend",
        ),
      ).rejects.toMatchObject({
        details: {
          reason: "SOURCE_NOT_FOUND",
        },
      });
    } finally {
      for (const window of windows) {
        driver.user32.symbols.DestroyWindow(window);
      }
      windowClass.release();
      driver.user32.close();
      driver.gdi32.close();
      await adapter.dispose();
      await adapter.dispose();
    }
    await expect(
      adapter.execute(
        "screenCapture.listSources",
        {
          types: [
            "screen",
          ],
        },
        "backend",
      ),
    ).rejects.toMatchObject({
      code: "CANCELLED",
    });
  },
);
