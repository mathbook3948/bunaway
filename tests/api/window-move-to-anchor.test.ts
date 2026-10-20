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
  WINDOW_ANCHORS,
  type WindowAnchor,
} from "#plugins/windows/src/contract";
import { anchorPosition } from "#plugins/windows/src/platforms/window-geometry";
import { createOperations } from "#plugins/windows/src/platforms/windows";

/** Pins `windows.moveToAnchor`: anchor coordinates, monitor selection, margin scaling and window state handling. */

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

test("each anchor lands on its corner, edge or center of the work area", () => {
  const expected: Record<
    WindowAnchor,
    [
      number,
      number,
    ]
  > = {
    "top-left": [
      100,
      -50,
    ],
    top: [
      400,
      -50,
    ],
    "top-right": [
      700,
      -50,
    ],
    left: [
      100,
      250,
    ],
    center: [
      400,
      250,
    ],
    right: [
      700,
      250,
    ],
    "bottom-left": [
      100,
      550,
    ],
    bottom: [
      400,
      550,
    ],
    "bottom-right": [
      700,
      550,
    ],
  };
  for (const [anchor, [x, y]] of Object.entries(expected)) {
    expect({
      anchor,
      ...anchorPosition(AREA, SIZE, anchor as WindowAnchor, 0),
    }).toEqual({
      anchor,
      x,
      y,
    });
  }
});

test("margin insets anchored edges and leaves centered axes alone", () => {
  expect(anchorPosition(AREA, SIZE, "top-left", 24)).toEqual({
    x: 124,
    y: -26,
  });
  expect(anchorPosition(AREA, SIZE, "bottom-right", 24)).toEqual({
    x: 676,
    y: 526,
  });
  expect(anchorPosition(AREA, SIZE, "top", 24)).toEqual({
    x: 400,
    y: -26,
  });
  expect(anchorPosition(AREA, SIZE, "right", 24)).toEqual({
    x: 676,
    y: 250,
  });
});

test("center rounds odd leftover space and negative origins like windows.center", () => {
  expect(
    anchorPosition(
      {
        x: -1920,
        y: 0,
        width: 1921,
        height: 1041,
      },
      {
        width: 800,
        height: 600,
      },
      "center",
      0,
    ),
  ).toEqual({
    x: Math.round(-1920 + (1921 - 800) / 2),
    y: Math.round((1041 - 600) / 2),
  });
});

test("a window larger than the inset work area is centered on that axis", () => {
  const big = {
    width: 1100,
    height: 200,
  };
  expect(anchorPosition(AREA, big, "top-left", 0)).toEqual({
    x: 50,
    y: -50,
  });
  expect(anchorPosition(AREA, SIZE, "top-left", 400)).toEqual({
    x: 400,
    y: 250,
  });
  expect(anchorPosition(AREA, SIZE, "bottom", 300)).toEqual({
    x: 400,
    y: 250,
  });
});

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
            nearestPoint: () => monitors[0],
            nearestRect: () => {
              log.push([
                "nearestRect",
                bounds.x,
              ]);
              return monitors[0];
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
      "windows.moveToAnchor",
      {
        view: "main",
        ...payload,
      } as JsonValue,
      "backend",
      {
        requestId: "request-1",
        permissions: {
          permissions: [
            "windows.moveToAnchor",
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

test("without monitorId the monitor nearest the window is used", async () => {
  const f = fixture();
  expect(
    await f.invoke({
      anchor: "bottom-right",
    }),
  ).toBeNull();
  expect(placed(f.log)).toEqual([
    {
      area: "outer",
      x: 700,
      y: 550,
    },
  ]);
});

test("monitorId selects that monitor and scales margin by its DPI", async () => {
  const f = fixture();
  await f.invoke({
    anchor: "top-left",
    monitorId: "b",
    margin: 10,
  });
  expect(placed(f.log)).toEqual([
    {
      area: "outer",
      x: 2020,
      y: 20,
    },
  ]);
  expect(f.log.some(([name]) => name === "nearestRect")).toBe(false);
});

test("an unknown monitorId is rejected and nothing moves", async () => {
  const f = fixture();
  await expect(
    f.invoke({
      anchor: "center",
      monitorId: "gone",
    }),
  ).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
    message: "Monitor is not connected.",
  });
  expect(placed(f.log)).toEqual([]);
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
      anchor: "top",
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
        x: 400,
        y: -50,
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
    anchor: "bottom-right",
  });
  expect(placed(f.log)).toEqual([
    {
      area: "outer",
      x: 700,
      y: 550,
    },
    {
      area: "outer",
      x: 500,
      y: 450,
    },
  ]);
});

test("fullscreen windows and platforms without monitors are rejected", async () => {
  const fullscreen = fixture({
    fullscreen: true,
  });
  await expect(
    fullscreen.invoke({
      anchor: "center",
    }),
  ).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
    message: "Exit fullscreen before moving the window to an anchor.",
  });
  expect(placed(fullscreen.log)).toEqual([]);
  const bare = fixture({
    withMonitors: false,
  });
  await expect(
    bare.invoke({
      anchor: "center",
    }),
  ).rejects.toMatchObject({
    code: "UNSUPPORTED",
    message: "Window anchoring is not implemented on this platform.",
  });
});

test("invalid anchors and margins fail validation", async () => {
  const f = fixture();
  for (const payload of [
    {
      anchor: "middle",
    },
    {
      anchor: "center",
      margin: -1,
    },
    {
      anchor: "center",
      margin: 1.5,
    },
    {
      anchor: "center",
      margin: 8193,
    },
    {
      anchor: "center",
      extra: 1,
    },
    {},
  ]) {
    await expect(f.invoke(payload)).rejects.toThrow();
  }
  expect(placed(f.log)).toEqual([]);
});

test("the contract accepts every anchor with optional monitorId and margin and returns null", () => {
  for (const anchor of WINDOW_ANCHORS) {
    expect(
      validateWindowCall({
        operation: "windows.moveToAnchor",
        payload: {
          view: "main",
          anchor,
          monitorId: "\\\\.\\DISPLAY1",
          margin: 8192,
        },
      }).payload,
    ).toEqual({
      view: "main",
      anchor,
      monitorId: "\\\\.\\DISPLAY1",
      margin: 8192,
    });
  }
  expect(validateWindowOutput("windows.moveToAnchor", null)).toBeNull();
  expect(() => validateWindowOutput("windows.moveToAnchor", true)).toThrow();
});
