import { expect, test } from "bun:test";
import { type CommandContext, command } from "@bunaway/backend";
import type { NativeWindowServices } from "@bunaway/plugin-api/native";
import windows, {
  validateWindowCall,
  validateWindowOutput,
  windowOperations,
} from "@bunaway/plugin-windows";
import {
  type HostContext,
  type JsonValue,
  NativeRegistry,
} from "@bunaway/protocol";
import { bindHostAPI } from "#core/host-api";
import { createOperations } from "#plugins/windows/src/platforms/windows";
import { testAppInfo } from "../fixtures/app-info.ts";
import { windowPermissions } from "../fixtures/window-permissions.ts";

const queries = [
  "getContentSize",
  "getOuterSize",
  "getContentPosition",
  "getOuterPosition",
  "getContentBounds",
  "getOuterBounds",
  "getNormalBounds",
] as const;
const setters = [
  {
    name: "setContentPosition",
    geometry: {
      x: -1,
      y: 3,
    },
  },
  {
    name: "setOuterSize",
    geometry: {
      width: 801,
      height: 601,
    },
  },
  {
    name: "setContentBounds",
    geometry: {
      x: -1,
      y: 3,
      width: 801,
      height: 601,
    },
  },
  {
    name: "setOuterBounds",
    geometry: {
      x: -1,
      y: 3,
      width: 801,
      height: 601,
    },
  },
] as const;

test("window geometry helpers preserve context, shapes, DPI and default units", async () => {
  const registry = new NativeRegistry([
    windows._definition,
  ]);
  const signal = new AbortController().signal;
  let calls = 0;
  const context: CommandContext = {
    app: testAppInfo,
    signal,
    state: {
      get: () => undefined,
      set() {},
      delete: () => false,
    },
    events: {
      async emit() {},
    },
    host: bindHostAPI(
      "editor" as HostContext,
      signal,
      async (source, call) => {
        expect(source).toBe("editor" as HostContext);
        calls++;
        let payload: JsonValue = {
          x: -120,
          y: 30,
          width: 1200,
          height: 900,
          dpi: 144,
        };
        if (call.operation.endsWith("Size")) {
          payload = {
            width: 1200,
            height: 900,
            dpi: 144,
          };
        }
        if (call.operation.endsWith("Position")) {
          payload = {
            x: -120,
            y: 30,
            dpi: 144,
          };
        }
        if (
          call.operation === "windows.toLogical" ||
          call.operation === "windows.toPhysical"
        ) {
          payload = {
            value: {
              x: -80,
              y: 20,
            },
            dpi: 144,
          };
        }
        if (
          call.operation.startsWith("windows.set") ||
          call.operation === "windows.center"
        ) {
          payload = null;
        }
        return {
          kind: "result",
          payload,
        };
      },
      registry,
    ),
  };
  await command({
    input: {
      const: null,
    },
    output: {
      const: null,
    },
    async handle() {
      for (const query of queries) {
        const result = await windows[query]({});
        expect(result.dpi).toBe(144);
        expect(validateWindowOutput(`windows.${query}`, result)).toEqual(
          result,
        );
      }
      expect(
        await windows.toLogical({
          value: {
            x: -120,
            y: 30,
          },
        }),
      ).toEqual({
        value: {
          x: -80,
          y: 20,
        },
        dpi: 144,
      });
      await windows.toPhysical({
        value: {
          x: -80,
          y: 20,
        },
      });
      expect(await windows.center({})).toBeNull();
      for (const { name, geometry } of setters) {
        switch (name) {
          case "setContentPosition":
            expect(
              await windows.setContentPosition({
                ...geometry,
              }),
            ).toBeNull();
            break;
          case "setOuterSize":
            expect(
              await windows.setOuterSize({
                ...geometry,
              }),
            ).toBeNull();
            break;
          case "setContentBounds":
            expect(
              await windows.setContentBounds({
                ...geometry,
              }),
            ).toBeNull();
            break;
          case "setOuterBounds":
            expect(
              await windows.setOuterBounds({
                ...geometry,
              }),
            ).toBeNull();
            break;
        }
      }
      return null;
    },
  }).run(null, context);
  expect(calls).toBe(14);
});

test("geometry schemas reject malformed shapes and out of range inputs and outputs", () => {
  for (const { name, geometry } of setters) {
    const payload = {
      ...geometry,
    };
    expect(
      validateWindowCall({
        operation: `windows.${name}`,
        payload,
      }).payload,
    ).toEqual(payload);
    const incomplete: Record<string, JsonValue> = {
      ...payload,
    };
    delete incomplete["x" in geometry ? "y" : "height"];
    expect(() =>
      validateWindowCall({
        operation: `windows.${name}`,
        payload: incomplete,
      }),
    ).toThrow();
    for (const invalid of [
      {
        ...payload,
        unit: "pixels",
      },
      {
        ...payload,
        extra: true,
      },
      {
        ...payload,
        ...("x" in geometry
          ? {
              x: 0.5,
            }
          : {
              width: -1,
            }),
      },
      {
        ...payload,
        ...("x" in geometry
          ? {
              x: -2147483649,
            }
          : {
              width: 2147483648,
            }),
      },
      {
        ...payload,
        ...("x" in geometry
          ? {
              y: null,
            }
          : {
              height: null,
            }),
      },
      {
        ...payload,
        ...("x" in geometry
          ? {
              x: NaN,
            }
          : {
              width: Infinity,
            }),
      },
    ]) {
      expect(() =>
        validateWindowCall({
          operation: `windows.${name}`,
          payload: invalid,
        }),
      ).toThrow();
    }
    expect(() => validateWindowOutput(`windows.${name}`, false)).toThrow();
  }
  for (const query of queries) {
    expect(
      validateWindowCall({
        operation: `windows.${query}`,
        payload: {
          unit: "logical",
        },
      }).operation,
    ).toBe(`windows.${query}`);
    expect(() =>
      validateWindowCall({
        operation: `windows.${query}`,
        payload: {
          unit: "pixels",
        },
      }),
    ).toThrow();
  }
  for (const operation of [
    "windows.toLogical",
    "windows.toPhysical",
  ] as const) {
    for (const value of [
      {
        x: 0,
      },
      {
        width: -1,
        height: 0,
      },
      {
        x: 0.5,
        y: 0,
      },
      {
        x: NaN,
        y: 0,
      },
      {
        x: Infinity,
        y: 0,
      },
      {
        x: -2147483649,
        y: 0,
      },
      {
        width: 2147483648,
        height: 0,
      },
      {
        x: 0,
        y: 0,
        extra: 1,
      },
    ]) {
      expect(() =>
        validateWindowCall({
          operation,
          payload: {
            value,
          },
        }),
      ).toThrow();
    }
    expect(() =>
      validateWindowOutput(operation, {
        value: {
          x: 0,
          y: 0,
        },
        dpi: 0,
      }),
    ).toThrow();
  }
  expect(() =>
    validateWindowOutput("windows.getOuterBounds", {
      x: 0,
      y: 0,
      width: -1,
      height: 0,
      dpi: 96,
    }),
  ).toThrow();
  expect(
    windowOperations["windows.getOuterSize"].output.shape.width.maxValue,
  ).toBe(2147483647);
});

/** Builds a one-window adapter whose native state the test changes through `state`. */
function createGeometryHarness() {
  const state = {
    closed: false,
    dpi: 144,
    fullscreen: false,
    cancelled: false,
    stopping: false,
    centerAvailable: true,
  };
  const applied: {
    area: string;
    geometry: JsonValue;
  }[] = [];
  const areas: string[] = [];
  const centerRequests: (string | undefined)[] = [];
  const services: NativeWindowServices = {
    specs: [
      {
        view: "main",
        title: "Main",
        home: "https://app.bunaway.local",
        window: {
          width: 800,
          height: 600,
        },
      },
    ],
    read: () => ({
      closed: state.closed,
      cleaned: state.closed,
      ready: true,
      failure: null,
      deadline: Infinity,
    }),
    create() {},
    close: () => true,
    stopping: () => state.stopping,
    cancelled: () => state.cancelled,
    now: Date.now,
    tick: async () => {},
    window: () => ({
      getReadiness() {
        throw new Error("Readiness is not used in this geometry test.");
      },
      getSnapshot() {
        throw new Error("Snapshot is not used in this geometry test.");
      },
      show() {},
      showInactive() {},
      activate: () => true,
      focus: () => true,
      close: () => true,
      minimize() {},
      maximize() {},
      unmaximize() {},
      restore() {},
      toggleMaximize() {},
      isMinimized: () => false,
      isMaximized: () => false,
      isVisible: () => true,
      isFocused: () => false,
      isFullscreen: () => state.fullscreen,
      getDpi: () => state.dpi,
      getBounds(area) {
        areas.push(area);
        return {
          x: -120,
          y: 30,
          width: 1200,
          height: 900,
          dpi: state.dpi,
        };
      },
      getSizeConstraints: () => ({
        minWidth: null,
        minHeight: null,
        maxWidth: null,
        maxHeight: null,
      }),
      setSizeConstraints() {},
      setSize() {},
      setPosition() {},
      ...(state.centerAvailable
        ? {
            center(monitorId?: string) {
              centerRequests.push(monitorId);
            },
          }
        : {}),
      setGeometry(area, geometry) {
        applied.push({
          area,
          geometry,
        });
      },
      setFullscreen() {},
      setCloseConfirmation() {},
    }),
  };
  const adapter = createOperations({
    dataRoot: ".",
    capabilities: [],
    windows: services,
  });
  const execute = adapter.executeUI;
  if (!execute) {
    throw new Error("Missing UI adapter");
  }
  const context = {
    requestId: "geometry",
    permissions: {
      permissions: [
        ...windowPermissions(),
      ],
    },
  };
  return {
    state,
    applied,
    areas,
    centerRequests,
    execute,
    context,
  };
}

type GeometryHarness = ReturnType<typeof createGeometryHarness>;

/** Rejects each window lifetime state: fullscreen and closed fail the call, cancelled and stopping cancel it. */
async function expectLifetimeRejections(
  harness: GeometryHarness,
  call: () => unknown,
): Promise<void> {
  const { state } = harness;
  for (const lifetime of [
    "fullscreen",
    "closed",
    "cancelled",
    "stopping",
  ] as const) {
    state.fullscreen = lifetime === "fullscreen";
    state.closed = lifetime === "closed";
    state.cancelled = lifetime === "cancelled";
    state.stopping = lifetime === "stopping";
    await expect(call()).rejects.toMatchObject({
      code:
        lifetime === "cancelled" || lifetime === "stopping"
          ? "CANCELLED"
          : "INVALID_ARGUMENT",
    });
  }
  state.fullscreen = false;
  state.closed = false;
  state.cancelled = false;
  state.stopping = false;
}

async function checkCenterOperation(harness: GeometryHarness): Promise<void> {
  const { state, centerRequests, execute, context } = harness;
  expect(await execute("windows.center", {}, "backend", context)).toBeNull();
  expect(centerRequests).toEqual([
    undefined,
  ]);
  expect(
    await execute(
      "windows.center",
      {
        monitorId: "\\\\.\\DISPLAY2",
      },
      "backend",
      context,
    ),
  ).toBeNull();
  expect(centerRequests).toEqual([
    undefined,
    "\\\\.\\DISPLAY2",
  ]);
  await expectLifetimeRejections(harness, () =>
    execute("windows.center", {}, "backend", context),
  );
  await expect(
    execute("windows.center", {}, "backend", {
      ...context,
      permissions: {
        permissions: [
          "windows.setPosition",
        ],
      },
    }),
  ).rejects.toMatchObject({
    code: "PERMISSION_DENIED",
  });
  await expect(
    execute(
      "windows.center",
      {
        view: "missing",
      },
      "backend",
      context,
    ),
  ).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  });
  expect(centerRequests).toHaveLength(2);
  for (const monitorId of [
    undefined,
    "\\\\.\\DISPLAY2",
  ]) {
    state.centerAvailable = false;
    await expect(
      execute(
        "windows.center",
        monitorId === undefined
          ? {}
          : {
              monitorId,
            },
        "backend",
        context,
      ),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
    state.centerAvailable = true;
  }
}

async function checkGeometrySetters(harness: GeometryHarness): Promise<void> {
  const { applied, execute, context } = harness;
  for (const { name, geometry } of setters) {
    const operation = `windows.${name}`;
    const payload = {
      ...geometry,
    };
    await execute(operation, payload, "backend", context);
    expect(applied.at(-1)).toEqual({
      area: name.startsWith("setContent") ? "content" : "outer",
      geometry,
    });
    await execute(
      operation,
      {
        ...payload,
        unit: "logical",
      },
      "backend",
      context,
    );
    expect(applied.at(-1)?.geometry).toEqual(
      Object.fromEntries(
        Object.entries(geometry).map(([key, value]) => [
          key,
          Math.round(value * 1.5) || 0,
        ]),
      ),
    );
    const count = applied.length;
    await expectLifetimeRejections(harness, () =>
      execute(operation, payload, "backend", context),
    );
    await expect(
      execute(operation, payload, "backend", {
        ...context,
        permissions: {
          permissions: [],
        },
      }),
    ).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
    await expect(
      execute(
        operation,
        {
          ...payload,
          view: "main",
        },
        "backend",
        context,
      ),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    await expect(
      execute(
        operation,
        {
          ...payload,
          windowId: "main",
        },
        "backend",
        context,
      ),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    if ("x" in geometry) {
      await expect(
        execute(
          operation,
          {
            ...payload,
            x: 2147483647,
            unit: "logical",
          },
          "backend",
          context,
        ),
      ).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
      });
    }
    expect(applied).toHaveLength(count);
  }
}

async function checkQueryOperations(harness: GeometryHarness): Promise<void> {
  const { areas, execute, context } = harness;
  for (const query of queries) {
    const result = await execute(
      `windows.${query}`,
      {
        unit: "logical",
      },
      "backend",
      context,
    );
    validateWindowOutput(`windows.${query}`, result);
    if (query.endsWith("Size")) {
      expect(result).toEqual({
        width: 800,
        height: 600,
        dpi: 144,
      });
    } else if (query.endsWith("Position")) {
      expect(result).toEqual({
        x: -80,
        y: 20,
        dpi: 144,
      });
    } else {
      expect(result).toEqual({
        x: -80,
        y: 20,
        width: 800,
        height: 600,
        dpi: 144,
      });
    }
  }
  expect(areas).toEqual([
    "content",
    "outer",
    "content",
    "outer",
    "content",
    "outer",
    "normal",
  ]);
  expect(
    await execute("windows.getOuterBounds", {}, "backend", context),
  ).toEqual({
    x: -120,
    y: 30,
    width: 1200,
    height: 900,
    dpi: 144,
  });
}

async function checkUnitConversions(harness: GeometryHarness): Promise<void> {
  const { state, execute, context } = harness;
  for (const dpi of [
    96,
    120,
    144,
    192,
  ]) {
    state.dpi = dpi;
    expect(
      await execute(
        "windows.toPhysical",
        {
          value: {
            x: -1,
            y: 1,
            width: 4097,
            height: 0,
          },
        },
        "backend",
        context,
      ),
    ).toEqual({
      value: {
        x: Math.round(-dpi / 96) || 0,
        y: Math.round(dpi / 96),
        width: Math.round((4097 * dpi) / 96),
        height: 0,
      },
      dpi,
    });
    expect(
      await execute(
        "windows.toLogical",
        {
          value: {
            x: -1,
            y: 1,
          },
        },
        "backend",
        context,
      ),
    ).toEqual({
      value: {
        x: Math.round(-96 / dpi) || 0,
        y: Math.round(96 / dpi),
      },
      dpi,
    });
  }
  await expect(
    execute(
      "windows.toPhysical",
      {
        value: {
          width: 2147483647,
          height: 0,
        },
      },
      "backend",
      context,
    ),
  ).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  });
}

async function checkReadOperationDenials(
  harness: GeometryHarness,
): Promise<void> {
  const { state, execute, context } = harness;
  for (const operation of [
    ...queries.map((query) => `windows.${query}`),
    "windows.toLogical",
    "windows.toPhysical",
  ]) {
    const payload = operation.includes(".to")
      ? {
          value: {
            x: 0,
            y: 0,
          },
        }
      : {};
    await expect(
      execute(operation, payload, "backend", {
        ...context,
        permissions: {
          permissions: [],
        },
      }),
    ).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
    await expect(
      execute(
        operation,
        {
          ...payload,
          view: "missing",
        },
        "backend",
        context,
      ),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    state.closed = true;
    await expect(
      execute(operation, payload, "backend", context),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    state.closed = false;
  }
}

test("geometry adapter selects the area, converts at current DPI, and enforces operation permission and lifetime", async () => {
  const harness = createGeometryHarness();
  await checkCenterOperation(harness);
  await checkGeometrySetters(harness);
  await checkQueryOperations(harness);
  await checkUnitConversions(harness);
  await checkReadOperationDenials(harness);
});

test("centering accepts only an optional monitor and null results", () => {
  expect(
    validateWindowCall({
      operation: "windows.center",
      payload: {},
    }).payload,
  ).toEqual({});
  expect(
    validateWindowCall({
      operation: "windows.center",
      payload: {
        monitorId: "\\\\.\\DISPLAY1",
      },
    }).payload,
  ).toEqual({
    monitorId: "\\\\.\\DISPLAY1",
  });
  for (const payload of [
    null,
    {
      view: "",
    },
    {
      windowId: "window-1",
    },
    {
      monitor: "primary",
    },
    {
      monitorId: "",
    },
    {
      monitorId: "x".repeat(33),
    },
    {
      monitorId: 1,
    },
    {
      monitorId: "\\\\.\\DISPLAY1",
      x: 1,
    },
    {
      x: 1,
    },
    {
      windowId: 1,
    },
  ]) {
    expect(() =>
      validateWindowCall({
        operation: "windows.center",
        payload,
      }),
    ).toThrow();
  }
  expect(validateWindowOutput("windows.center", null)).toBeNull();
  expect(() => validateWindowOutput("windows.center", true)).toThrow();
});
