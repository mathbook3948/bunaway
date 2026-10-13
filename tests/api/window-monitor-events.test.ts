import { expect, test } from "bun:test";
import type {
  NativeMonitorSnapshot,
  NativeWindowServices,
} from "@bunaway/plugin-api/native";
import {
  type MonitorSnapshot,
  monitorChangeSchema,
  monitorSnapshotSchema,
  validateWindowCall,
  validateWindowOutput,
  windowEvents,
  windowsPlugin,
} from "@bunaway/plugin-windows";
import { NativeRegistry, validateValue } from "@bunaway/protocol";
import { createOperations } from "#plugins/windows/src/platforms/windows";
import { fixtureMonitor } from "../fixtures/monitors.ts";

const snapshot: NativeMonitorSnapshot = {
  sourceId: crypto.randomUUID(),
  revision: 0,
  monitors: [
    fixtureMonitor(),
  ],
  error: null,
};
const change = {
  sourceId: snapshot.sourceId,
  revision: 1,
  added: [
    snapshot.monitors[0]?.id ?? "",
  ],
  removed: [],
  changed: [],
  error: null,
};

test("monitor snapshot safe parsing reports malformed protocol errors without throwing", async () => {
  for (const error of [
    {
      code: "INTERNAL",
    },
    {
      code: "NOT_A_WIRE_CODE",
      message: "Invalid code",
    },
  ]) {
    const input = {
      ...snapshot,
      error,
    };
    const result = monitorSnapshotSchema.safeParse(input);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({
          path: [
            "error",
          ],
        }),
      );
    }
    const asyncResult = await monitorSnapshotSchema.safeParseAsync(input);
    expect(asyncResult.success).toBe(false);
    if (!asyncResult.success) {
      expect(asyncResult.error.issues).toContainEqual(
        expect.objectContaining({
          path: [
            "error",
          ],
        }),
      );
    }
  }
});

test("monitor snapshot and event public contracts validate revisions, metrics, errors and unknown fields", () => {
  // Public Zod declarations and native host contracts must agree, including nullable error details.
  const publicSnapshot: MonitorSnapshot = snapshot;
  const nativeSnapshot: NativeMonitorSnapshot =
    monitorSnapshotSchema.parse(publicSnapshot);
  expect(nativeSnapshot).toEqual(snapshot);
  expect(validateWindowOutput("windows.getMonitorSnapshot", snapshot)).toEqual(
    snapshot,
  );
  expect(windowEvents["windows.monitorsChanged"]).toEqual(monitorChangeSchema);
  expect(validateValue(monitorChangeSchema, change)).toEqual(change);
  const error = {
    code: "INTERNAL",
    message: "Display information is unavailable.",
    details: null,
  } as const;
  expect(
    monitorSnapshotSchema.parse({
      ...snapshot,
      error,
    }).error,
  ).toEqual(error);
  expect(
    validateValue(monitorChangeSchema, {
      ...change,
      error,
    }).error,
  ).toEqual(error);
  for (const invalid of [
    {
      ...snapshot,
      sourceId: "invalid",
    },
    {
      ...snapshot,
      revision: -1,
    },
    {
      ...snapshot,
      revision: 0.5,
    },
    {
      ...snapshot,
      error: {
        code: "INTERNAL",
      },
    },
    {
      ...snapshot,
      error: {
        code: "NOT_A_WIRE_CODE",
        message: "bad",
      },
    },
    {
      ...snapshot,
      monitors: [
        {
          ...fixtureMonitor(),
          dpi: 0,
        },
      ],
    },
    {
      ...snapshot,
      extra: true,
    },
  ]) {
    expect(() => monitorSnapshotSchema.parse(invalid)).toThrow();
  }
  for (const invalid of [
    {
      ...change,
      revision: 0,
    },
    {
      ...change,
      revision: Number.MAX_SAFE_INTEGER + 1,
    },
    {
      ...change,
      sourceId: "invalid",
    },
    {
      ...change,
      sourceId: "------------------------------------",
    },
    {
      ...change,
      added: [
        "",
      ],
    },
    {
      ...change,
      added: [
        "duplicate",
        "duplicate",
      ],
    },
    {
      ...change,
      changed: [
        "x".repeat(33),
      ],
    },
    {
      ...change,
      error: {
        code: "INTERNAL",
      },
    },
    {
      ...change,
      extra: true,
    },
  ]) {
    expect(() => validateValue(monitorChangeSchema, invalid)).toThrow();
  }
  expect(
    new NativeRegistry([
      windowsPlugin,
    ]).operation("windows.getMonitorSnapshot"),
  ).toBeDefined();
  expect(
    validateWindowCall({
      operation: "windows.getMonitorSnapshot",
      payload: null,
    }).payload,
  ).toBeNull();
  expect(() =>
    validateWindowCall({
      operation: "windows.getMonitorSnapshot",
      payload: {
        view: "main",
      },
    }),
  ).toThrow();
});

test("monitor snapshot needs its own grant, honors cancellation, and reports missing snapshot support without a window", async () => {
  let reads = 0;
  let cancelled = false;
  let stopping = false;
  const services: NativeWindowServices = {
    specs: [],
    monitors: {
      list: () => snapshot.monitors,
      snapshot: () => {
        reads++;
        return snapshot;
      },
      primary: () => fixtureMonitor(),
      nearestPoint: () => fixtureMonitor(),
      nearestRect: () => fixtureMonitor(),
      cursor: () => ({
        x: 0,
        y: 0,
      }),
    },
    read: () => undefined,
    create() {},
    close: () => true,
    window() {
      throw new Error("Snapshot must not resolve a window.");
    },
    cancelled: () => cancelled,
    stopping: () => stopping,
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
    requestId: "monitor-snapshot",
    permissions: {
      permissions: [
        "windows.getMonitorSnapshot",
      ],
    },
  };
  try {
    await expect(
      execute("windows.getMonitorSnapshot", null, "backend", {
        ...context,
        permissions: {
          permissions: [
            "windows.getMonitors",
          ],
        },
      }),
    ).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
    expect(reads).toBe(0);
    expect(
      await execute("windows.getMonitorSnapshot", null, "backend", context),
    ).toEqual(snapshot);
    cancelled = true;
    await expect(
      execute("windows.getMonitorSnapshot", null, "backend", context),
    ).rejects.toMatchObject({
      code: "CANCELLED",
    });
    cancelled = false;
    stopping = true;
    await expect(
      execute("windows.getMonitorSnapshot", null, "backend", context),
    ).rejects.toMatchObject({
      code: "CANCELLED",
    });
    expect(reads).toBe(1);
    stopping = false;
    if (!services.monitors) {
      throw new Error("Missing fixture monitors");
    }
    delete services.monitors.snapshot;
    await expect(
      execute("windows.getMonitorSnapshot", null, "backend", context),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
    delete services.monitors;
    await expect(
      execute("windows.getMonitorSnapshot", null, "backend", context),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
  } finally {
    await adapter.dispose();
  }
});
