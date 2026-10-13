import { expect, test } from "bun:test";
import type {
  NativeMonitor,
  NativeWindowServices,
} from "@bunaway/plugin-api/native";
import {
  monitorSchema,
  validateWindowCall,
  validateWindowOutput,
  windowsPlugin,
} from "@bunaway/plugin-windows";
import { NativeRegistry } from "@bunaway/protocol";
import { createOperations } from "#plugins/windows/src/platforms/windows";

const monitor: NativeMonitor = {
  id: "\\\\.\\DISPLAY2",
  name: "Secondary",
  primary: false,
  bounds: {
    x: -1920,
    y: -200,
    width: 1920,
    height: 1080,
  },
  workArea: {
    x: -1920,
    y: -200,
    width: 1920,
    height: 1040,
  },
  dpi: 144,
  scaleFactor: 1.5,
  rotation: 90,
  refreshRate: 60,
};

test("monitor contracts accept negative origins and reject truncated or overflowing native rectangles", () => {
  expect(monitorSchema.parse(monitor)).toEqual(monitor);
  for (const payload of [
    {
      x: 0.1,
      y: 0,
    },
    {
      x: 0,
      y: 2147483648,
    },
    {
      x: 0,
      y: 0,
      extra: true,
    },
  ]) {
    expect(() =>
      validateWindowCall({
        operation: "windows.getMonitorNearestPoint",
        payload,
      }),
    ).toThrow();
  }
  for (const payload of [
    {
      x: 0,
      y: 0,
      width: 0,
      height: 10,
    },
    {
      x: 2147483647,
      y: 0,
      width: 1,
      height: 1,
    },
    {
      x: 0,
      y: 2147483647,
      width: 1,
      height: 1,
    },
    {
      x: 0,
      y: 0,
      width: 10,
    },
  ]) {
    expect(() =>
      validateWindowCall({
        operation: "windows.getMonitorNearestRect",
        payload,
      }),
    ).toThrow();
  }
  expect(
    validateWindowCall({
      operation: "windows.getMonitorNearestRect",
      payload: monitor.bounds,
    }).payload,
  ).toEqual(monitor.bounds);
  expect(() =>
    validateWindowOutput("windows.getMonitor", {
      ...monitor,
      dpi: 0,
    }),
  ).toThrow();
  expect(() =>
    validateWindowOutput("windows.getMonitor", {
      ...monitor,
      rotation: 45,
    }),
  ).toThrow();
  expect(
    validateWindowOutput("windows.getMonitor", {
      ...monitor,
      rotation: null,
      refreshRate: null,
    }).refreshRate,
  ).toBeNull();
  const registry = new NativeRegistry([
    windowsPlugin,
  ]);
  for (const operation of [
    "getMonitors",
    "getPrimaryMonitor",
    "getMonitor",
    "getMonitorNearestPoint",
    "getMonitorNearestRect",
    "getCursorPosition",
  ]) {
    expect(registry.operation(`windows.${operation}`)).toBeDefined();
  }
});

test("global monitor queries require individual grants and cancellation, without resolving a window", async () => {
  let cancelled = false;
  let stopping = false;
  let reads = 0;
  const services: NativeWindowServices = {
    specs: [],
    monitors: {
      list: () => {
        reads++;
        return [
          monitor,
        ];
      },
      primary: () => ({
        ...monitor,
        primary: true,
      }),
      nearestPoint: () => monitor,
      nearestRect: () => monitor,
      cursor: () => ({
        x: -100,
        y: 80,
      }),
    },
    read: () => undefined,
    create() {},
    close: () => true,
    window() {
      throw new Error("Global queries must not resolve a window.");
    },
    stopping: () => stopping,
    cancelled: () => cancelled,
    now: Date.now,
    tick: async () => {},
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
    requestId: "monitor-test",
    permissions: {
      permissions: [
        "windows.getMonitors",
      ],
    },
  };
  await expect(
    execute("windows.getMonitors", null, "backend", {
      ...context,
      permissions: {
        permissions: [],
      },
    }),
  ).rejects.toMatchObject({
    code: "PERMISSION_DENIED",
  });
  expect(reads).toBe(0);
  expect(
    await execute("windows.getMonitors", null, "backend", context),
  ).toEqual([
    monitor,
  ]);
  await expect(
    execute("windows.getPrimaryMonitor", null, "backend", context),
  ).rejects.toMatchObject({
    code: "PERMISSION_DENIED",
  });
  for (const operation of [
    "windows.getMonitorNearestPoint",
    "windows.getMonitorNearestRect",
  ]) {
    const payload = operation.endsWith("Point")
      ? {
          x: -100,
          y: 0,
        }
      : monitor.bounds;
    expect(
      await execute(operation, payload, "backend", {
        ...context,
        permissions: {
          permissions: [
            operation,
          ],
        },
      }),
    ).toEqual(monitor);
  }
  cancelled = true;
  await expect(
    execute("windows.getMonitors", null, "backend", context),
  ).rejects.toMatchObject({
    code: "CANCELLED",
  });
  cancelled = false;
  stopping = true;
  await expect(
    execute("windows.getMonitors", null, "backend", context),
  ).rejects.toMatchObject({
    code: "CANCELLED",
  });
  stopping = false;
  delete services.monitors;
  await expect(
    execute("windows.getMonitors", null, "backend", context),
  ).rejects.toMatchObject({
    code: "UNSUPPORTED",
  });
  await adapter.dispose();
});
