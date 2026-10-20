import { expect, test } from "bun:test";
import type {
  NativeMonitor,
  NativeWindow,
  NativeWindowServices,
} from "@bunaway/plugin-api/native";
import {
  validateWindowCall,
  validateWindowOutput,
} from "@bunaway/plugin-windows";
import type { JsonValue } from "@bunaway/protocol";
import {
  WINDOW_RECT_ALIGNMENTS,
  WINDOW_RECT_PLACEMENTS,
} from "#plugins/windows/src/contract";
import { rectPlacementPosition } from "#plugins/windows/src/platforms/window-geometry";
import { createOperations } from "#plugins/windows/src/platforms/windows";

/** Pins `windows.moveNextToRect`: side and alignment coordinates, work-area clamping without flipping, monitor selection and window state handling. */

const AREA = {
  x: 100,
  y: -50,
  width: 1000,
  height: 800,
};
const SIZE = {
  width: 400,
  height: 200,
};
const TARGET = {
  x: 500,
  y: 300,
  width: 100,
  height: 40,
};

function monitor(id: string, dpi: number, workArea = AREA): NativeMonitor {
  return {
    id,
    name: id,
    primary: id === "a",
    bounds: workArea,
    workArea,
    dpi,
    scaleFactor: dpi / 96,
  } as NativeMonitor;
}

const OTHER_AREA = {
  x: 2000,
  y: 0,
  width: 1600,
  height: 900,
};

function fixture(
  options: {
    state?: "normal" | "minimized" | "maximized";
    fullscreen?: boolean;
    withMonitors?: boolean;
    /** Size after the first placement, to model a DPI-driven resize. */
    resizedTo?: {
      width: number;
      height: number;
    };
  } = {},
) {
  const log: Array<
    [
      string,
      unknown,
    ]
  > = [];
  let bounds = {
    x: 1500,
    y: 10,
    ...SIZE,
    dpi: 96,
  };
  let placements = 0;
  const monitors = [
    monitor("a", 96),
    monitor("b", 192, OTHER_AREA),
  ];
  const window = {
    isFullscreen: () => options.fullscreen === true,
    isMinimized: () => options.state === "minimized",
    isMaximized: () => options.state === "maximized",
    getBounds: (area: string) => {
      log.push([
        "getBounds",
        area,
      ]);
      return bounds;
    },
    setGeometry: (
      area: string,
      geometry: {
        x: number;
        y: number;
      },
    ) => {
      log.push([
        "setGeometry",
        {
          area,
          ...geometry,
        },
      ]);
      placements += 1;
      bounds = {
        ...bounds,
        ...geometry,
        ...(placements === 1 ? options.resizedTo : undefined),
      };
    },
  } as unknown as NativeWindow;
  const services = {
    specs: [
      {
        view: "main",
        home: "https://app.bunaway.local/index.html",
        title: "main",
        window: {
          width: 800,
          height: 600,
        },
      },
    ],
    read: () => ({
      closed: false,
      cleaned: false,
      ready: true,
      failure: undefined,
      deadline: Infinity,
    }),
    create: () => {
      throw new Error("Unexpected native service call");
    },
    close: () => true,
    window: () => window,
    stopping: () => false,
    cancelled: () => false,
    now: Date.now,
    tick: async () => {},
    ...(options.withMonitors === false
      ? {}
      : {
          monitors: {
            list: () => monitors,
            primary: () => monitors[0],
            nearestPoint: (point: { x: number }) => {
              log.push([
                "nearestPoint",
                point.x,
              ]);
              return point.x >= OTHER_AREA.x ? monitors[1] : monitors[0];
            },
            nearestRect: (rect: { x: number }) => {
              log.push([
                "nearestRect",
                rect,
              ]);
              return rect.x >= OTHER_AREA.x ? monitors[1] : monitors[0];
            },
            cursor: () => ({
              x: 0,
              y: 0,
            }),
          },
        }),
  } as unknown as NativeWindowServices;
  const adapter = createOperations({
    dataRoot: ".",
    capabilities: [],
    windows: services,
  });
  const invoke = (payload: Record<string, unknown>) => {
    if (!adapter.executeUI) {
      throw new Error("Missing UI adapter");
    }
    return adapter.executeUI(
      "windows.moveNextToRect",
      {
        view: "main",
        ...payload,
      } as JsonValue,
      "backend",
      {
        requestId: "request-1",
        permissions: {
          permissions: [
            "windows.moveNextToRect",
          ],
        },
      },
    );
  };
  return {
    log,
    invoke,
  };
}

const placed = (
  log: Array<
    [
      string,
      unknown,
    ]
  >,
) => log.filter(([name]) => name === "setGeometry").map(([, value]) => value);

test("each side and alignment lands next to the reference rectangle", () => {
  const at = (
    placement: "above" | "below" | "left" | "right",
    align: "start" | "center" | "end",
  ) => rectPlacementPosition(AREA, SIZE, TARGET, placement, align, 0);
  expect(at("above", "center")).toEqual({
    x: 350,
    y: 100,
  });
  expect(at("above", "start")).toEqual({
    x: 500,
    y: 100,
  });
  expect(at("above", "end")).toEqual({
    x: 200,
    y: 100,
  });
  expect(at("below", "start")).toEqual({
    x: 500,
    y: 340,
  });
  expect(at("left", "end")).toEqual({
    x: 100,
    y: 140,
  });
  expect(at("left", "start")).toEqual({
    x: 100,
    y: 300,
  });
  expect(at("right", "center")).toEqual({
    x: 600,
    y: 220,
  });
  expect(at("right", "end")).toEqual({
    x: 600,
    y: 140,
  });
  for (const placement of WINDOW_RECT_PLACEMENTS) {
    for (const align of WINDOW_RECT_ALIGNMENTS) {
      const { x, y } = at(placement, align);
      expect(x).toBeGreaterThanOrEqual(AREA.x);
      expect(y).toBeGreaterThanOrEqual(AREA.y);
    }
  }
});

test("margin separates the window from the reference rectangle", () => {
  expect(
    rectPlacementPosition(AREA, SIZE, TARGET, "above", "start", 8),
  ).toEqual({
    x: 500,
    y: 92,
  });
  expect(
    rectPlacementPosition(AREA, SIZE, TARGET, "below", "start", 8),
  ).toEqual({
    x: 500,
    y: 348,
  });
  expect(
    rectPlacementPosition(
      AREA,
      SIZE,
      {
        ...TARGET,
        x: 700,
      },
      "left",
      "start",
      8,
    ),
  ).toEqual({
    x: 292,
    y: 300,
  });
  expect(
    rectPlacementPosition(AREA, SIZE, TARGET, "right", "start", 8),
  ).toEqual({
    x: 608,
    y: 300,
  });
});

test("a window that does not fit is moved into the work area and never flipped to the other side", () => {
  const corner = {
    x: 1050,
    y: 720,
    width: 32,
    height: 30,
  };
  expect(
    rectPlacementPosition(AREA, SIZE, corner, "above", "center", 0),
  ).toEqual({
    x: 700,
    y: 520,
  });
  expect(
    rectPlacementPosition(AREA, SIZE, corner, "below", "center", 0),
  ).toEqual({
    x: 700,
    y: 550,
  });
  expect(
    rectPlacementPosition(
      AREA,
      SIZE,
      {
        ...corner,
        x: 110,
      },
      "left",
      "center",
      0,
    ),
  ).toEqual({
    x: 100,
    y: 550,
  });
  expect(
    rectPlacementPosition(
      AREA,
      SIZE,
      {
        ...corner,
        y: -45,
      },
      "above",
      "center",
      0,
    ),
  ).toEqual({
    x: 700,
    y: -50,
  });
});

test("a reference rectangle outside the work area is clamped to its nearest edge", () => {
  expect(
    rectPlacementPosition(
      AREA,
      SIZE,
      {
        x: 5000,
        y: 5000,
        width: 20,
        height: 20,
      },
      "above",
      "center",
      0,
    ),
  ).toEqual({
    x: 700,
    y: 550,
  });
});

test("a window larger than the work area is centered on that axis", () => {
  expect(
    rectPlacementPosition(
      AREA,
      {
        width: 1200,
        height: 900,
      },
      TARGET,
      "below",
      "start",
      0,
    ),
  ).toEqual({
    x: 0,
    y: -100,
  });
});

test("the monitor nearest the reference rectangle is used and margin scales by its DPI", async () => {
  const f = fixture();
  expect(
    await f.invoke({
      rect: {
        x: 2100,
        y: 400,
        width: 40,
        height: 40,
      },
      placement: "below",
      align: "start",
      margin: 10,
    }),
  ).toBeNull();
  expect(placed(f.log)).toEqual([
    {
      area: "outer",
      x: 2100,
      y: 460,
    },
  ]);
  expect(f.log.filter(([name]) => name === "nearestRect")).toEqual([
    [
      "nearestRect",
      {
        x: 2100,
        y: 400,
        width: 40,
        height: 40,
      },
    ],
  ]);
});

test("align defaults to center and margin to zero", async () => {
  const f = fixture();
  await f.invoke({
    rect: TARGET,
    placement: "above",
  });
  expect(placed(f.log)).toEqual([
    {
      area: "outer",
      x: 350,
      y: 100,
    },
  ]);
});

test("minimized and maximized windows only move their normal restoration bounds", async () => {
  for (const state of [
    "minimized",
    "maximized",
  ] as const) {
    const f = fixture({
      state,
    });
    await f.invoke({
      rect: TARGET,
      placement: "above",
    });
    const areas = f.log
      .filter(([name]) => name === "getBounds")
      .map(([, area]) => area);
    expect(areas.length).toBeGreaterThan(0);
    expect(new Set(areas)).toEqual(
      new Set([
        "normal",
      ]),
    );
    expect(placed(f.log)).toEqual([
      {
        area: "outer",
        x: 350,
        y: 100,
      },
    ]);
  }
});

test("a size change caused by the first placement is followed by a second placement", async () => {
  const f = fixture({
    resizedTo: {
      width: 600,
      height: 300,
    },
  });
  await f.invoke({
    rect: TARGET,
    placement: "below",
  });
  expect(placed(f.log)).toEqual([
    {
      area: "outer",
      x: 350,
      y: 340,
    },
    {
      area: "outer",
      x: 250,
      y: 340,
    },
  ]);
});

test("fullscreen windows and platforms without monitors are rejected", async () => {
  const fullscreen = fixture({
    fullscreen: true,
  });
  await expect(
    fullscreen.invoke({
      rect: TARGET,
      placement: "above",
    }),
  ).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
    message: "Exit fullscreen before moving the window next to a rectangle.",
  });
  expect(placed(fullscreen.log)).toEqual([]);
  const bare = fixture({
    withMonitors: false,
  });
  await expect(
    bare.invoke({
      rect: TARGET,
      placement: "above",
    }),
  ).rejects.toMatchObject({
    code: "UNSUPPORTED",
    message:
      "Placing a window next to a rectangle is not implemented on this platform.",
  });
});

test("invalid rectangles, sides, alignments and margins fail validation", async () => {
  const f = fixture();
  for (const payload of [
    {
      placement: "above",
    },
    {
      rect: TARGET,
    },
    {
      rect: TARGET,
      placement: "inside",
    },
    {
      rect: TARGET,
      placement: "above",
      align: "middle",
    },
    {
      rect: TARGET,
      placement: "above",
      margin: -1,
    },
    {
      rect: TARGET,
      placement: "above",
      margin: 1.5,
    },
    {
      rect: TARGET,
      placement: "above",
      margin: 8193,
    },
    {
      rect: {
        ...TARGET,
        width: -1,
      },
      placement: "above",
    },
    {
      rect: {
        x: 2147483600,
        y: 0,
        width: 100,
        height: 10,
      },
      placement: "above",
    },
    {
      rect: {
        ...TARGET,
        x: 0.5,
      },
      placement: "above",
    },
    {
      rect: {
        ...TARGET,
        extra: 1,
      },
      placement: "above",
    },
    {
      rect: TARGET,
      placement: "above",
      extra: 1,
    },
  ]) {
    await expect(f.invoke(payload)).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  }
  expect(placed(f.log)).toEqual([]);
});

test("the contract accepts every side and alignment and returns null", () => {
  for (const placement of WINDOW_RECT_PLACEMENTS) {
    for (const align of WINDOW_RECT_ALIGNMENTS) {
      const payload = {
        view: "main",
        rect: TARGET,
        placement,
        align,
        margin: 8192,
      };
      expect(
        validateWindowCall({
          operation: "windows.moveNextToRect",
          payload,
        }).payload,
      ).toEqual(payload);
    }
  }
  expect(validateWindowOutput("windows.moveNextToRect", null)).toBeNull();
  expect(() => validateWindowOutput("windows.moveNextToRect", true)).toThrow();
});

test("an empty reference rectangle is accepted and resolves the monitor from its point", async () => {
  const f = fixture();
  await f.invoke({
    rect: {
      x: 600,
      y: 340,
      width: 0,
      height: 0,
    },
    placement: "below",
    align: "start",
  });
  expect(placed(f.log)).toEqual([
    {
      area: "outer",
      x: 600,
      y: 340,
    },
  ]);
  expect(f.log.some(([name]) => name === "nearestRect")).toBe(false);
  const other = fixture();
  await other.invoke({
    rect: {
      x: 2100,
      y: 400,
      width: 0,
      height: 0,
    },
    placement: "below",
    align: "start",
    margin: 10,
  });
  expect(placed(other.log)).toEqual([
    {
      area: "outer",
      x: 2100,
      y: 420,
    },
  ]);
});
