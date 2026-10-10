import { expect, test } from "bun:test";
import { type CommandContext, command } from "@bunaway/backend";
import type { NativeWindowServices } from "@bunaway/plugin-api/native";
import {
  validateWindowCall,
  validateWindowOutput,
  windowOperations,
  windows,
  windowsPlugin,
} from "@bunaway/plugin-windows";
import {
  type HostContext,
  type JsonValue,
  NativeRegistry,
} from "@bunaway/protocol";
import { bindHostAPI } from "#core/host-api";
import { createOperations } from "#plugins/windows/src/windows";

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
    windowsPlugin,
  ]);
  const signal = new AbortController().signal;
  let calls = 0;
  const context: CommandContext = {
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
        if (call.operation.startsWith("windows.set")) {
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
        const result = await windows[query]({
          view: "main",
        });
        expect(result.dpi).toBe(144);
        expect(validateWindowOutput(`windows.${query}`, result)).toEqual(
          result,
        );
      }
      expect(
        await windows.toLogical({
          view: "main",
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
        view: "main",
        value: {
          x: -80,
          y: 20,
        },
      });
      for (const { name, geometry } of setters) {
        switch (name) {
          case "setContentPosition":
            expect(
              await windows.setContentPosition({
                view: "main",
                ...geometry,
              }),
            ).toBeNull();
            break;
          case "setOuterSize":
            expect(
              await windows.setOuterSize({
                view: "main",
                ...geometry,
              }),
            ).toBeNull();
            break;
          case "setContentBounds":
            expect(
              await windows.setContentBounds({
                view: "main",
                ...geometry,
              }),
            ).toBeNull();
            break;
          case "setOuterBounds":
            expect(
              await windows.setOuterBounds({
                view: "main",
                ...geometry,
              }),
            ).toBeNull();
            break;
        }
      }
      return null;
    },
  }).run(null, context);
  expect(calls).toBe(13);
});

test("geometry schemas reject malformed shapes and out of range inputs and outputs", () => {
  for (const { name, geometry } of setters) {
    const payload = {
      view: "main",
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
          view: "main",
          unit: "logical",
        },
      }).operation,
    ).toBe(`windows.${query}`);
    expect(() =>
      validateWindowCall({
        operation: `windows.${query}`,
        payload: {
          view: "main",
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
            view: "main",
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
    windowOperations["windows.getOuterSize"].output.properties.width.maximum,
  ).toBe(2147483647);
});

test("geometry adapter selects the area, converts at current DPI, and enforces target permission and lifetime", async () => {
  let closed = false;
  let dpi = 144;
  let fullscreen = false;
  let cancelled = false;
  let stopping = false;
  const applied: {
    area: string;
    geometry: JsonValue;
  }[] = [];
  const areas: string[] = [];
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
      closed,
      cleaned: closed,
      ready: true,
      failure: null,
      deadline: Infinity,
    }),
    create() {},
    close: () => true,
    stopping: () => stopping,
    cancelled: () => cancelled,
    now: Date.now,
    tick: async () => {},
    window: () => ({
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
      isFullscreen: () => fullscreen,
      getDpi: () => dpi,
      getBounds(area) {
        areas.push(area);
        return {
          x: -120,
          y: 30,
          width: 1200,
          height: 900,
          dpi,
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
        {
          identifier: "windows:control",
          allow: [
            {
              view: "main",
            },
          ],
        },
      ],
    },
  };
  for (const { name, geometry } of setters) {
    const operation = `windows.${name}`;
    const payload = {
      view: "main",
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
    for (const state of [
      "fullscreen",
      "closed",
      "cancelled",
      "stopping",
    ] as const) {
      fullscreen = state === "fullscreen";
      closed = state === "closed";
      cancelled = state === "cancelled";
      stopping = state === "stopping";
      await expect(
        execute(operation, payload, "backend", context),
      ).rejects.toMatchObject({
        code:
          state === "cancelled" || state === "stopping"
            ? "CANCELLED"
            : "INVALID_ARGUMENT",
      });
    }
    fullscreen = closed = cancelled = stopping = false;
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
      code: "PERMISSION_DENIED",
    });
    for (const denied of [
      true,
      false,
    ]) {
      const view = denied ? "main" : "missing";
      await expect(
        execute(
          operation,
          {
            ...payload,
            view,
          },
          "backend",
          {
            ...context,
            permissions: {
              permissions: [
                {
                  identifier: "windows:control",
                  allow: [
                    {
                      view,
                    },
                  ],
                  deny: denied
                    ? [
                        {
                          view,
                        },
                      ]
                    : [],
                },
              ],
            },
          },
        ),
      ).rejects.toMatchObject({
        code: denied ? "PERMISSION_DENIED" : "INVALID_ARGUMENT",
      });
    }
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
  for (const query of queries) {
    const result = await execute(
      `windows.${query}`,
      {
        view: "main",
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
    await execute(
      "windows.getOuterBounds",
      {
        view: "main",
      },
      "backend",
      context,
    ),
  ).toEqual({
    x: -120,
    y: 30,
    width: 1200,
    height: 900,
    dpi: 144,
  });
  for (const targetDpi of [
    96,
    120,
    144,
    192,
  ]) {
    dpi = targetDpi;
    expect(
      await execute(
        "windows.toPhysical",
        {
          view: "main",
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
          view: "main",
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
        view: "main",
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
  for (const operation of [
    ...queries.map((query) => `windows.${query}`),
    "windows.toLogical",
    "windows.toPhysical",
  ]) {
    const payload = operation.includes(".to")
      ? {
          view: "main",
          value: {
            x: 0,
            y: 0,
          },
        }
      : {
          view: "main",
        };
    await expect(
      execute(operation, payload, "backend", {
        ...context,
        permissions: {
          permissions: [
            {
              identifier: "windows:control",
              allow: [
                {
                  view: "main",
                },
              ],
              deny: [
                {
                  view: "main",
                },
              ],
            },
          ],
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
      code: "PERMISSION_DENIED",
    });
    closed = true;
    await expect(
      execute(operation, payload, "backend", context),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    closed = false;
  }
});
