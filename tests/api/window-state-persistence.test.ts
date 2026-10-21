import { expect, test } from "bun:test";
import windowState from "@bunaway/plugin-window-state";
import type { Monitor } from "@bunaway/plugin-windows";
import { fitToMonitors } from "#plugins/window-state/src/placement";
import {
  createWindowState,
  type WindowStateDependencies,
} from "#plugins/window-state/src/state";

function monitor(overrides: Partial<Monitor> & Pick<Monitor, "id">): Monitor {
  return {
    name: overrides.id,
    primary: false,
    bounds: {
      x: 0,
      y: 0,
      width: 1920,
      height: 1080,
    },
    workArea: {
      x: 0,
      y: 0,
      width: 1920,
      height: 1040,
    },
    dpi: 96,
    scaleFactor: 1,
    rotation: null,
    refreshRate: null,
    ...overrides,
  };
}

const primary = monitor({
  id: "1",
  primary: true,
});
const right = monitor({
  id: "2",
  bounds: {
    x: 1920,
    y: 0,
    width: 1920,
    height: 1080,
  },
  workArea: {
    x: 1920,
    y: 0,
    width: 1920,
    height: 1040,
  },
});
const saved = {
  x: 100,
  y: 80,
  width: 800,
  height: 600,
  dpi: 96,
};

test("a saved rectangle that still shows keeps its place", () => {
  expect(
    fitToMonitors(saved, [
      primary,
    ]),
  ).toEqual({
    bounds: {
      x: 100,
      y: 80,
      width: 800,
      height: 600,
    },
    adjusted: false,
  });
  // Mostly off the left edge, but 100 physical pixels remain on screen.
  expect(
    fitToMonitors(
      {
        ...saved,
        x: -700,
      },
      [
        primary,
      ],
    ).bounds.x,
  ).toBe(-700);
});

test("a rectangle on a monitor that is gone is centered on the primary work area", () => {
  const away = {
    ...saved,
    x: 2500,
  };
  expect(
    fitToMonitors(away, [
      primary,
    ]),
  ).toEqual({
    bounds: {
      x: 560,
      y: 220,
      width: 800,
      height: 600,
    },
    adjusted: true,
  });
  // The same rectangle stays put while that monitor exists.
  expect(
    fitToMonitors(away, [
      primary,
      right,
    ]).adjusted,
  ).toBe(false);
});

test("a sliver of the rectangle on screen does not count as visible", () => {
  const sliver = {
    ...saved,
    x: 1920 - 20,
  };
  expect(
    fitToMonitors(sliver, [
      primary,
    ]).bounds.x,
  ).toBe(560);
});

test("the size follows the DPI ratio and never exceeds the work area", () => {
  const dense = monitor({
    id: "1",
    primary: true,
    dpi: 192,
    scaleFactor: 2,
  });
  expect(
    fitToMonitors(saved, [
      dense,
    ]).bounds,
  ).toMatchObject({
    width: 1600,
    // 600 doubled is 1200, which the 1040 pixel work area cuts back.
    height: 1040,
  });
  const huge = {
    ...saved,
    width: 4000,
    height: 3000,
  };
  expect(
    fitToMonitors(huge, [
      primary,
    ]).bounds,
  ).toMatchObject({
    width: 1920,
    height: 1040,
  });
  expect(fitToMonitors(saved, [])).toEqual({
    bounds: {
      x: 100,
      y: 80,
      width: 800,
      height: 600,
    },
    adjusted: false,
  });
});

type Display = {
  maximized: boolean;
  fullscreen: boolean;
  visible: boolean;
  minimized?: boolean;
};

/** In-memory window and store clients; `calls` records the order of window operations. */
function fixture(
  display: Display,
  monitors: Monitor[] = [
    primary,
  ],
) {
  const calls: string[] = [];
  const records = new Map<string, unknown>();
  const loads: unknown[] = [];
  let normal = {
    x: 100,
    y: 80,
    width: 800,
    height: 600,
    dpi: 96,
  };
  const behavior: {
    resizedByDpiChange: boolean;
    landsAtDpi?: number;
    windowDpi: number;
    frame: {
      width: number;
      height: number;
    };
  } = {
    resizedByDpiChange: false,
    windowDpi: 96,
    frame: {
      width: 0,
      height: 0,
    },
  };
  const windows = {
    getMonitors: async () => monitors,
    getNormalBounds: async () => normal,
    getOuterBounds: async () => ({
      ...normal,
      dpi: behavior.windowDpi,
    }),
    getContentBounds: async () => ({
      ...normal,
      width: normal.width - behavior.frame.width,
      height: normal.height - behavior.frame.height,
      dpi: behavior.windowDpi,
    }),
    getSnapshot: async () => ({
      windowId: "main",
      viewId: "main",
      revision: 1,
      state: {
        visible: display.visible,
        focused: true,
        minimized: display.minimized ?? false,
        maximized: display.maximized,
        fullscreen: display.fullscreen,
        alwaysOnTop: false,
      },
      bounds: {
        ...normal,
      },
    }),
    hide: async () => void calls.push("hide"),
    maximize: async () => void calls.push("maximize"),
    setFullscreen: async (input: { fullscreen: boolean }) =>
      void calls.push(`fullscreen:${input.fullscreen}`),
    setOuterBounds: async (input: {
      x: number;
      y: number;
      width: number;
      height: number;
    }) => {
      calls.push(`bounds:${input.x},${input.y}`);
      if (behavior.resizedByDpiChange) {
        // The OS resizes the window after the call when it crosses to another DPI.
        behavior.resizedByDpiChange = false;
        const ratio = behavior.landsAtDpi
          ? behavior.landsAtDpi / behavior.windowDpi
          : 2;
        behavior.windowDpi = behavior.landsAtDpi ?? behavior.windowDpi;
        normal = {
          ...normal,
          x: input.x,
          y: input.y,
          width: Math.round(input.width * ratio),
          height: Math.round(input.height * ratio),
        };
        return null;
      }
      normal = {
        ...normal,
        x: input.x,
        y: input.y,
        width: input.width,
        height: input.height,
      };
      return null;
    },
    show: async () => void calls.push("show"),
    unmaximize: async () => void calls.push("unmaximize"),
  };
  const store = {
    load: async (input: unknown) => {
      loads.push(input);
      return {
        loaded: "new" as const,
      };
    },
    get: async ({ key }: { key: string }) =>
      records.has(key)
        ? {
            found: true,
            value: records.get(key),
          }
        : {
            found: false,
          },
    set: async ({ key, value }: { key: string; value: unknown }) => {
      records.set(key, value);
      return {
        changed: true,
      };
    },
    delete: async ({ key }: { key: string }) => ({
      changed: records.delete(key),
    }),
    save: async () => null,
  };
  return {
    api: createWindowState({
      windows,
      store,
    } as unknown as WindowStateDependencies),
    calls,
    records,
    loads,
    behavior,
    setNormal: (next: typeof normal) => {
      normal = next;
    },
  };
}

test("save keeps the normal bounds with the maximized, fullscreen and visible state", async () => {
  const { api, records, loads } = fixture({
    maximized: true,
    fullscreen: false,
    visible: true,
  });
  await api.save({
    view: "main",
  });
  expect(records.get("main")).toEqual({
    version: 1,
    x: 100,
    y: 80,
    width: 800,
    height: 600,
    dpi: 96,
    maximized: true,
    fullscreen: false,
    visible: true,
  });
  // Every call opens the same store with fixed options, so a damaged file is replaced.
  expect(loads[0]).toEqual({
    name: "window-state",
    autosave: false,
    onInvalidFile: "reset",
  });
});

test("restore applies the saved bounds and leaves visibility alone by default", async () => {
  const { api, calls } = fixture({
    maximized: false,
    fullscreen: false,
    visible: false,
  });
  await api.save({
    view: "main",
    key: "saved",
  });
  const result = await api.restore({
    view: "main",
    key: "saved",
  });
  expect(result).toEqual({
    restored: true,
    adjusted: false,
  });
  expect(calls).toEqual([
    "bounds:100,80",
  ]);
});

test("restore leaves fullscreen before changing geometry and re-enters it last", async () => {
  const display = {
    maximized: true,
    fullscreen: true,
    visible: true,
  };
  const state = fixture(display);
  await state.api.save({
    view: "main",
  });
  // The window is fullscreen again but no longer maximized when restore runs.
  display.maximized = false;
  const result = await state.api.restore({
    view: "main",
    include: {
      visible: true,
    },
  });
  expect(result.restored).toBe(true);
  expect(state.calls).toEqual([
    "fullscreen:false",
    "bounds:100,80",
    "maximize",
    "fullscreen:true",
    "show",
  ]);
});

test("restore un-maximizes a window whose saved state was not maximized", async () => {
  const { api, calls, records } = fixture({
    maximized: true,
    fullscreen: false,
    visible: true,
  });
  records.set("main", {
    version: 1,
    x: 10,
    y: 20,
    width: 640,
    height: 480,
    dpi: 96,
    maximized: false,
    fullscreen: false,
    visible: false,
  });
  await api.restore({
    view: "main",
    include: {
      visible: true,
    },
  });
  expect(calls).toEqual([
    "bounds:10,20",
    "unmaximize",
    "hide",
  ]);
});

test("include limits what restore touches", async () => {
  const { api, calls, records, setNormal } = fixture({
    maximized: false,
    fullscreen: false,
    visible: true,
  });
  records.set("main", {
    version: 1,
    x: 300,
    y: 200,
    width: 1000,
    height: 700,
    dpi: 96,
    maximized: true,
    fullscreen: true,
    visible: true,
  });
  setNormal({
    x: 5,
    y: 6,
    width: 500,
    height: 400,
    dpi: 96,
  });
  await api.restore({
    view: "main",
    include: {
      size: false,
      maximized: false,
      fullscreen: false,
    },
  });
  expect(calls).toEqual([
    "bounds:300,200",
  ]);
  await api.restore({
    view: "main",
    include: {
      position: false,
      size: false,
      maximized: false,
      fullscreen: false,
    },
  });
  expect(calls).toEqual([
    "bounds:300,200",
  ]);
});

test("restore reports adjusted when the monitor is gone", async () => {
  const { api, calls, records } = fixture({
    maximized: false,
    fullscreen: false,
    visible: true,
  });
  records.set("main", {
    version: 1,
    x: 5000,
    y: 80,
    width: 800,
    height: 600,
    dpi: 96,
    maximized: false,
    fullscreen: false,
    visible: true,
  });
  expect(
    await api.restore({
      view: "main",
    }),
  ).toEqual({
    restored: true,
    adjusted: true,
  });
  expect(calls).toEqual([
    "bounds:560,220",
  ]);
});

test("a missing or invalid record restores nothing and touches no window", async () => {
  const { api, calls, records } = fixture({
    maximized: false,
    fullscreen: false,
    visible: true,
  });
  const none = {
    restored: false,
    adjusted: false,
  };
  expect(
    await api.restore({
      view: "main",
    }),
  ).toEqual(none);
  for (const value of [
    null,
    "text",
    {
      version: 2,
    },
    {
      version: 1,
      x: 0.5,
      y: 0,
      width: 10,
      height: 10,
      dpi: 96,
    },
    {
      version: 1,
      x: 0,
      y: 0,
      width: -4,
      height: 10,
      dpi: 96,
      maximized: false,
      fullscreen: false,
      visible: true,
    },
  ]) {
    records.set("main", value);
    expect(
      await api.restore({
        view: "main",
      }),
    ).toEqual(none);
  }
  expect(calls).toEqual([]);
});

test("remove deletes the saved state and reports whether one existed", async () => {
  const { api, records } = fixture({
    maximized: false,
    fullscreen: false,
    visible: true,
  });
  await api.save({
    view: "main",
  });
  expect(
    await api.remove({
      view: "main",
    }),
  ).toEqual({
    removed: true,
  });
  expect(records.size).toBe(0);
  expect(
    await api.remove({
      view: "main",
    }),
  ).toEqual({
    removed: false,
  });
  expect(
    await api.restore({
      view: "main",
    }),
  ).toEqual({
    restored: false,
    adjusted: false,
  });
});

test("inputs outside the contract are rejected before any call", async () => {
  const { api, calls, loads } = fixture({
    maximized: false,
    fullscreen: false,
    visible: true,
  });
  await expect(
    api.save({
      view: "a/b",
    }),
  ).rejects.toThrow();
  await expect(
    api.restore({
      view: "main",
      key: "x".repeat(129),
    }),
  ).rejects.toThrow();
  await expect(
    api.restore({
      view: "main",
      include: {
        extra: true,
      } as never,
    }),
  ).rejects.toThrow();
  await expect(api.remove({})).rejects.toThrow();
  expect(calls).toEqual([]);
  expect(loads).toEqual([]);
});

const plainRecord = {
  version: 1,
  x: 10,
  y: 20,
  width: 640,
  height: 480,
  dpi: 96,
  maximized: false,
  fullscreen: false,
  visible: true,
};

test("restore places the window again when a DPI change resized it", async () => {
  const { api, calls, records, behavior } = fixture({
    maximized: false,
    fullscreen: false,
    visible: true,
  });
  records.set("main", plainRecord);
  behavior.resizedByDpiChange = true;
  await api.restore({
    view: "main",
  });
  expect(calls).toEqual([
    "bounds:10,20",
    "bounds:10,20",
  ]);
});

test("a window that lands on a lower DPI is fitted again with that DPI's limits", async () => {
  const { api, records, behavior, setNormal } = fixture({
    maximized: false,
    fullscreen: false,
    visible: true,
  });
  // Created on a 192 DPI monitor, restored onto the 96 DPI monitor the record names.
  behavior.windowDpi = 192;
  behavior.landsAtDpi = 96;
  behavior.frame = {
    width: 16,
    height: 39,
  };
  setNormal({
    x: 0,
    y: 0,
    width: 900,
    height: 700,
    dpi: 192,
  });
  records.set("main", {
    ...plainRecord,
    width: 316,
    height: 300,
  });
  behavior.resizedByDpiChange = true;
  await api.restore({
    view: "main",
  });
  await api.save({
    view: "main",
  });
  // The first placement is held to the 192 DPI minimum, the second keeps the saved size.
  expect(records.get("main")).toMatchObject({
    width: 316,
    height: 300,
  });
});

test("a minimized window is restored without measuring a frame", async () => {
  const { api, records, behavior, setNormal } = fixture({
    maximized: false,
    fullscreen: false,
    visible: true,
    minimized: true,
  });
  // The icon rectangle would suggest a frame of 160 by 28.
  behavior.frame = {
    width: 160,
    height: 28,
  };
  setNormal({
    x: 0,
    y: 0,
    width: 900,
    height: 700,
    dpi: 96,
  });
  records.set("main", {
    ...plainRecord,
    width: 260,
    height: 240,
  });
  expect(
    await api.restore({
      view: "main",
    }),
  ).toEqual({
    restored: true,
    adjusted: false,
  });
});

test("a hidden window stays hidden after maximize shows it", async () => {
  const { api, calls, records } = fixture({
    maximized: false,
    fullscreen: false,
    visible: false,
  });
  records.set("main", {
    ...plainRecord,
    maximized: true,
  });
  await api.restore({
    view: "main",
  });
  expect(calls).toEqual([
    "bounds:10,20",
    "maximize",
    "hide",
  ]);
});

test("saving a minimized window keeps the maximized state saved before", async () => {
  const display = {
    maximized: false,
    fullscreen: false,
    visible: true,
    minimized: true,
  };
  const earlier = fixture(display);
  earlier.records.set("main", {
    ...plainRecord,
    maximized: true,
  });
  await earlier.api.save({
    view: "main",
  });
  expect(earlier.records.get("main")).toMatchObject({
    maximized: true,
  });
  const fresh = fixture(display);
  await fresh.api.save({
    view: "main",
  });
  expect(fresh.records.get("main")).toMatchObject({
    maximized: false,
  });
});

test("size limits are logical pixels converted at the monitor DPI", () => {
  const dense = monitor({
    id: "1",
    primary: true,
    dpi: 192,
    scaleFactor: 2,
    bounds: {
      x: 0,
      y: 0,
      width: 5120,
      height: 2880,
    },
    workArea: {
      x: 0,
      y: 0,
      width: 5120,
      height: 2840,
    },
  });
  const wide = {
    x: 0,
    y: 0,
    width: 4500,
    height: 1500,
    dpi: 192,
  };
  expect(
    fitToMonitors(wide, [
      dense,
    ]),
  ).toEqual({
    bounds: {
      x: 0,
      y: 0,
      width: 4500,
      height: 1500,
    },
    adjusted: false,
  });
  expect(
    fitToMonitors(
      {
        ...wide,
        width: 300,
      },
      [
        dense,
      ],
    ).bounds.width,
  ).toBe(400);
});

test("an already maximized window is not maximized again", async () => {
  const { api, calls, records } = fixture({
    maximized: true,
    fullscreen: false,
    visible: false,
  });
  records.set("main", {
    ...plainRecord,
    maximized: true,
  });
  await api.restore({
    view: "main",
  });
  expect(calls).toEqual([
    "bounds:10,20",
  ]);
});

test("restored sizes respect the content size limits at the window DPI", async () => {
  const { api, records, behavior, setNormal } = fixture({
    maximized: false,
    fullscreen: false,
    visible: true,
  });
  behavior.windowDpi = 192;
  behavior.frame = {
    width: 16,
    height: 39,
  };
  setNormal({
    x: 0,
    y: 0,
    width: 900,
    height: 700,
    dpi: 192,
  });
  records.set("main", {
    ...plainRecord,
    width: 216,
    height: 100,
  });
  await api.restore({
    view: "main",
  });
  // 200 logical content pixels at DPI 192 plus the frame.
  expect(
    await api.save({
      view: "main",
    }),
  ).toBeNull();
  expect(records.get("main")).toMatchObject({
    width: 416,
    height: 439,
  });
});

test("the plugin declares no native operation of its own", () => {
  expect(windowState._definition.native.operations).toEqual([]);
  expect(typeof windowState.save).toBe("function");
  expect(typeof windowState.restore).toBe("function");
  expect(typeof windowState.remove).toBe("function");
});
