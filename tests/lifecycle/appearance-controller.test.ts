import { expect, test } from "bun:test";
import type {
  NativeAppearanceWindow,
  NativeSystemSignal,
} from "@bunaway/plugin-api/native";
import { BunawayError } from "@bunaway/protocol";
import { AppearanceWindows } from "#native/windows/bun/appearance";
import type { AppearancePreferences } from "#plugins/appearance/src/contract";
import { createAppearanceController } from "#plugins/appearance/src/platforms/windows-controller";

function fixture() {
  let snapshot: AppearancePreferences = {
    appsTheme: "light",
    systemTheme: "dark",
    accentColor: "#123456",
    highContrast: false,
    forcedColors: false,
    invertedColors: false,
    reducedMotion: false,
    transparencyEnabled: true,
    screenReaderEnabled: false,
    colors: {
      window: "#ffffff",
      windowText: "#000000",
      highlight: "#123456",
      highlightText: "#ffffff",
    },
  };
  const frames = new Map<bigint, boolean>();
  const events: unknown[] = [];
  let receive: ((signal: NativeSystemSignal) => void) | undefined;
  let closes = 0;
  let disposed = false;
  let failRead = false;
  let failWindow: bigint | undefined;
  const service = new AppearanceWindows(() => ({
    setDark(hwnd, value) {
      if (hwnd === failWindow) {
        throw new Error("DWM failed");
      }
      frames.set(hwnd, value);
    },
    dispose() {
      closes++;
    },
  }));
  const controller = createAppearanceController(
    {
      read() {
        if (failRead) {
          throw new Error("Read failed");
        }
        return structuredClone(snapshot);
      },
      dispose() {
        disposed = true;
      },
    },
    {
      appearance: service,
      systemEvents: {
        subscribe(callback) {
          receive = callback;
          return () => {
            receive = undefined;
          };
        },
        publish(...args) {
          events.push(args);
        },
      },
    },
  );
  return {
    service,
    controller,
    frames,
    events,
    get closes() {
      return closes;
    },
    get disposed() {
      return disposed;
    },
    failRead(value: boolean) {
      failRead = value;
    },
    failWindow(value?: bigint) {
      failWindow = value;
    },
    change(value: Partial<AppearancePreferences>) {
      snapshot = {
        ...snapshot,
        ...value,
      };
    },
    signal(signal: NativeSystemSignal = "themeChanged") {
      receive?.(signal);
    },
    captureSignal() {
      return receive;
    },
  };
}

test("system defaults, app inheritance, explicit system override, high contrast and retired windows", () => {
  const f = fixture();
  f.service.attach("first", 1n);
  expect(f.controller.getTheme("first")).toEqual({
    preference: "system",
    override: null,
    effectiveTheme: "light",
    highContrast: false,
  });
  expect(f.frames.get(1n)).toBe(false);
  f.controller.setTheme(null, "dark");
  f.service.attach("second", 2n);
  expect([
    ...f.frames.values(),
  ]).toEqual([
    true,
    true,
  ]);
  f.controller.setTheme("first", "system");
  expect(f.frames.get(1n)).toBe(false);
  f.change({
    appsTheme: "dark",
  });
  f.signal();
  expect(f.frames.get(1n)).toBe(true);
  f.controller.setTheme("second", "light");
  f.change({
    highContrast: true,
    forcedColors: true,
  });
  f.signal("settingChanged");
  expect([
    ...f.frames.values(),
  ]).toEqual([
    false,
    false,
  ]);
  expect(f.controller.getTheme("first")).toMatchObject({
    preference: "system",
    effectiveTheme: null,
    highContrast: true,
  });
  f.change({
    highContrast: false,
    forcedColors: false,
  });
  f.signal("colorsChanged");
  expect([
    ...f.frames.values(),
  ]).toEqual([
    true,
    false,
  ]);
  f.controller.setTheme("second", null);
  expect(f.controller.getTheme("second")).toMatchObject({
    preference: "dark",
    override: null,
  });
  f.service.detach("first");
  expect(() => f.controller.setTheme("first", "light")).toThrow(
    expect.objectContaining({
      code: "INVALID_ARGUMENT",
    }),
  );
  f.service.attach("replacement", 1n);
  expect(f.controller.getTheme("replacement").override).toBeNull();
  f.controller.dispose();
  f.controller.dispose();
  expect(f.disposed).toBe(true);
  expect(f.closes).toBe(1);
  expect([
    ...f.frames.values(),
  ]).toEqual([
    false,
    false,
  ]);
  expect(() => f.controller.getTheme(null)).toThrow(
    expect.objectContaining({
      code: "CANCELLED",
    }),
  );
});

test("OS changes deduplicate snapshots, preserve query semantics and release listeners", () => {
  const f = fixture();
  f.service.attach("first", 1n);
  f.signal();
  f.signal("colorsChanged");
  expect(f.events).toEqual([]);
  f.change({
    accentColor: "#abcdef",
  });
  expect(f.controller.read().accentColor).toBe("#abcdef");
  f.signal("accentChanged");
  f.signal("settingChanged");
  expect(f.events).toHaveLength(1);
  expect(f.events[0]).toEqual([
    "appearance.changed",
    expect.objectContaining({
      accentColor: "#abcdef",
    }),
    "appearance.getPreferences",
  ]);
  f.change({
    appsTheme: "dark",
  });
  f.failRead(true);
  expect(() => f.signal()).toThrow("Read failed");
  expect(f.events).toHaveLength(1);
  f.failRead(false);
  f.signal();
  expect(f.events).toHaveLength(2);
  expect(f.frames.get(1n)).toBe(true);
  f.change({
    reducedMotion: true,
  });
  f.signal("powerStatusChanged");
  expect(f.events).toHaveLength(2);
  f.signal("resume");
  expect(f.events).toHaveLength(3);
  const queued = f.captureSignal();
  f.controller.dispose();
  queued?.("themeChanged");
  expect(f.events).toHaveLength(3);
});

test("refresh failures still publish OS changes and recover on the next signal", () => {
  const f = fixture();
  f.service.attach("first", 1n);
  f.service.attach("second", 2n);
  f.failWindow(1n);
  f.change({
    appsTheme: "dark",
  });
  expect(() => f.signal()).toThrow("Appearance refresh failed");
  expect(f.frames.get(2n)).toBe(true);
  expect(f.controller.getTheme("first").effectiveTheme).toBe("light");
  expect(f.controller.getTheme("second").effectiveTheme).toBe("dark");
  expect(f.events).toHaveLength(1);
  f.failWindow();
  f.signal();
  expect(f.frames.get(1n)).toBe(true);
  expect(f.events).toHaveLength(1);
  f.controller.dispose();
});

test("app mutation rollback preserves prior preference and attempts every inherited window", () => {
  const f = fixture();
  f.service.attach("first", 1n);
  f.service.attach("second", 2n);
  f.failWindow(2n);
  expect(() => f.controller.setTheme(null, "dark")).toThrow(
    "Appearance change and rollback failed",
  );
  expect(f.controller.getTheme(null).preference).toBe("system");
  expect(f.frames.get(1n)).toBe(false);
  f.failWindow();
  f.controller.dispose();
});

test("native subscription cannot outlive its owner or address a reused HWND", () => {
  const frames: boolean[] = [];
  let closes = 0;
  const service = new AppearanceWindows(() => ({
    setDark: (_hwnd, dark) => {
      frames.push(dark);
    },
    dispose: () => {
      closes++;
    },
  }));
  service.attach("first", 1n);
  let first: NativeAppearanceWindow | undefined;
  const release = service.subscribe((window) => {
    first = window;
    return () => {};
  });
  first?.setDark(true);
  const original = first;
  service.detach("first");
  service.attach("second", 1n);
  expect(() => original?.setDark(true)).toThrow(
    expect.objectContaining({
      code: "CANCELLED",
    }),
  );
  expect(() => first?.setDark(true)).not.toThrow();
  const retired = first;
  service.detach("second");
  expect(() => retired?.setDark(true)).toThrow(
    expect.objectContaining({
      code: "CANCELLED",
    }),
  );
  release();
  const secondRelease = service.subscribe(() => () => {});
  release();
  expect(closes).toBe(1);
  secondRelease();
  expect(closes).toBe(2);
});

test("old hosts preserve queries but report unsupported frame control", () => {
  const f = fixture();
  const read = f.controller.read();
  f.controller.dispose();
  const controller = createAppearanceController({
    read: () => read,
    dispose() {},
  });
  expect(controller.read()).toEqual(read);
  expect(() => controller.getTheme(null)).toThrow(
    expect.objectContaining({
      code: "UNSUPPORTED",
    }),
  );
  controller.dispose();
  const unsupported = new AppearanceWindows(() => ({
    setDark() {
      throw new BunawayError({
        code: "UNSUPPORTED",
        message: "Old DWM",
      });
    },
    dispose() {},
  }));
  const old = createAppearanceController(
    {
      read: () => read,
      dispose() {},
    },
    {
      appearance: unsupported,
    },
  );
  expect(() => unsupported.attach("old", 1n)).not.toThrow();
  expect(() => old.getTheme("old")).toThrow(
    expect.objectContaining({
      code: "UNSUPPORTED",
    }),
  );
  old.dispose();
});

test("content color scheme follows the theme, replays into late content and resets on disposal", () => {
  const f = fixture();
  const schemes: string[] = [];
  f.service.attach("first", 1n);
  // The theme chosen before the content exists reaches it as soon as it binds.
  f.controller.setTheme("first", "dark");
  f.service.bindContent("first", (scheme) => {
    schemes.push(scheme);
  });
  expect(schemes).toEqual([
    "dark",
  ]);
  f.controller.setTheme("first", "light");
  f.controller.setTheme("first", "system");
  f.controller.setTheme(null, "dark");
  expect(schemes).toEqual([
    "dark",
    "light",
    "auto",
  ]);
  f.controller.setTheme("first", null);
  expect(schemes.at(-1)).toBe("dark");
  // High contrast keeps the OS colors, so an explicit theme does not pin the content.
  f.change({
    highContrast: true,
    forcedColors: true,
  });
  f.signal("settingChanged");
  expect(schemes.at(-1)).toBe("auto");
  f.controller.setTheme(null, "dark");
  // Disposing the controller releases the subscription, which hands the content back to the OS.
  f.controller.dispose();
  expect(schemes.at(-1)).toBe("auto");
});

test("content color scheme ends with its window and an unbound window ignores it", () => {
  const f = fixture();
  const schemes: string[] = [];
  f.service.attach("first", 1n);
  f.service.bindContent("first", (scheme) => {
    schemes.push(scheme);
  });
  f.service.attach("second", 2n);
  f.controller.setTheme("second", "dark");
  expect(schemes).toEqual([
    "auto",
  ]);
  f.service.detach("first");
  f.controller.setTheme(null, "light");
  expect(schemes).toEqual([
    "auto",
  ]);
  // Binding after detach cannot resurrect the lifetime.
  f.service.bindContent("first", (scheme) => {
    schemes.push(scheme);
  });
  f.controller.setTheme(null, "dark");
  expect(schemes).toEqual([
    "auto",
  ]);
  f.controller.dispose();
});

test("a failing content update leaves the window override unchanged", () => {
  const f = fixture();
  let failing = false;
  f.service.attach("first", 1n);
  f.service.bindContent("first", () => {
    if (failing) {
      // Only the first update fails; the resync after it succeeds.
      failing = false;
      throw new BunawayError({
        code: "INTERNAL",
        message: "Profile failed.",
      });
    }
  });
  failing = true;
  expect(() => f.controller.setTheme("first", "dark")).toThrow(
    "Profile failed.",
  );
  expect(f.controller.getTheme("first").override).toBeNull();
  expect(f.controller.getTheme("first").effectiveTheme).toBe("light");
  // The frame that already turned dark is put back to match the reported state.
  expect(f.frames.get(1n)).toBe(false);
  f.service.detach("first");
  f.controller.dispose();
});
