import { expect, test } from "bun:test";
import { windowPermissions } from "../fixtures/window-permissions.ts";
import type {
  NativeWindowServices,
  WindowIdentity,
} from "@bunaway/plugin-api/native";
import {
  validateWindowCall,
  validateWindowOutput,
  windows,
  windowsPlugin,
} from "@bunaway/plugin-windows";
import { NativeRegistry, type Policy } from "@bunaway/protocol";
import { createOperations } from "#plugins/windows/src/platforms/windows";

const queries = [
  "getById",
  "getCurrent",
  "getFocused",
  "getLastActive",
] as const;
const registry = new NativeRegistry([
  windowsPlugin,
]);
const main = {
  windowId: "window-main",
  viewId: "main",
};
const privateWindow = {
  windowId: "window-private",
  viewId: "private",
};

function fixture({ ready = true }: { ready?: boolean } = {}) {
  const identities = new Map<string, WindowIdentity>([
    [
      "main",
      {
        ...main,
      },
    ],
    [
      "private",
      {
        ...privateWindow,
      },
    ],
  ]);
  const closed = new Set<string>();
  let focused: WindowIdentity | null = null;
  let lastActive: WindowIdentity | null = null;
  let cancelled = false;
  const services: NativeWindowServices = {
    specs: [
      "main",
      "private",
      "deferred",
    ].map((view) => ({
      view,
      title: view,
      home: "https://app.bunaway.local",
      window: {
        width: 800,
        height: 600,
      },
    })),
    lookup: {
      byId: (id) =>
        [
          ...identities.values(),
        ].find((identity) => identity.windowId === id) ?? null,
      byView: (view) => identities.get(view) ?? null,
      focused: () => focused,
      lastActive: () => lastActive,
    },
    read: (view) =>
      identities.has(view)
        ? {
            closed: closed.has(view),
            cleaned: false,
            ready,
            failure: null,
            deadline: Infinity,
          }
        : undefined,
    create() {
      throw new Error("Queries must not create windows.");
    },
    close() {
      throw new Error("Queries must not close windows.");
    },
    window() {
      throw new Error(
        "Identity queries must not read mutable snapshots or control windows.",
      );
    },
    stopping: () => false,
    cancelled: () => cancelled,
    now: Date.now,
    tick: async () => {},
  };
  const permissions: Policy["backend"] = {
    permissions: [
      ...windowPermissions(),
    ],
  };
  const adapter = createOperations({
    dataRoot: ".",
    capabilities: [],
    windows: services,
  });
  const execute = adapter.executeUI;
  if (!execute) {
    throw new Error("Missing UI adapter.");
  }
  return {
    identities,
    closed,
    permissions,
    services,
    invoke: (
      name: (typeof queries)[number] | "isDestroyed",
      input: Parameters<typeof execute>[1] = null,
      source = "view:main",
    ) =>
      Promise.resolve().then(() =>
        execute(`windows.${name}`, input, source, {
          requestId: name,
          permissions,
        }),
      ),
    activate: (identity: WindowIdentity | null) => {
      focused = identity;
      if (identity) {
        lastActive = identity;
      }
    },
    cancel: () => {
      cancelled = true;
    },
  };
}

test("lookup schemas use opaque IDs, null selector inputs and nullable identities", () => {
  for (const name of queries) {
    const operation = `windows.${name}` as const;
    expect(registry.operation(operation).name).toBe(operation);
    expect(windows[name]).toBeFunction();
    validateWindowCall({
      operation,
      payload:
        name === "getById"
          ? {
              windowId: main.windowId,
            }
          : null,
    });
    expect(validateWindowOutput(operation, null)).toBeNull();
    expect(validateWindowOutput(operation, main)).toEqual(main);
    for (const input of [
      {
        view: "main",
      },
      {
        windowId: "",
      },
      {
        windowId: "window-main\n",
      },
      {
        windowId: 1,
      },
      {
        windowId: "window-main",
        view: "main",
      },
    ]) {
      expect(() =>
        validateWindowCall({
          operation,
          payload: input,
        }),
      ).toThrow();
    }
    for (const output of [
      true,
      {},
      {
        viewId: "main",
      },
      {
        ...main,
        open: true,
      },
    ]) {
      expect(() => validateWindowOutput(operation, output)).toThrow();
    }
  }
});

test("lookup distinguishes authenticated current, focused and last active without changing native state", async () => {
  const f = fixture();
  expect(await f.invoke("getCurrent")).toEqual(main);
  expect(await f.invoke("getCurrent", null, "backend")).toBeNull();
  await expect(f.invoke("getCurrent", null, "main")).rejects.toMatchObject({
    code: "PERMISSION_DENIED",
  });
  expect(await f.invoke("getFocused")).toBeNull();
  expect(await f.invoke("getLastActive")).toBeNull();
  f.activate(main);
  expect(await f.invoke("getFocused")).toEqual(main);
  expect(await f.invoke("getLastActive")).toEqual(main);
  f.activate(null);
  expect(await f.invoke("getFocused")).toBeNull();
  expect(await f.invoke("getLastActive")).toEqual(main);
  f.closed.add("main");
  expect(await f.invoke("getCurrent")).toBeNull();
  expect(await f.invoke("getLastActive")).toBeNull();
});

test("lookup results cannot mutate native identity tracking", async () => {
  const f = fixture();
  const current = validateWindowOutput(
    "windows.getCurrent",
    await f.invoke("getCurrent"),
  );
  expect(current).toEqual(main);
  if (!current) {
    throw new Error("The authenticated main window must have an identity.");
  }
  current.windowId = "caller-modified-id";
  current.viewId = "private";
  expect(await f.invoke("getCurrent")).toEqual(main);
  expect(
    await f.invoke("getById", {
      windowId: main.windowId,
    }),
  ).toEqual(main);
  expect(
    await f.invoke("getById", {
      windowId: current.windowId,
    }),
  ).toBeNull();
});

test("lookup covers declared targets and hides obsolete IDs without substituting another window", async () => {
  const f = fixture();
  expect(
    await f.invoke("getById", {
      windowId: main.windowId,
    }),
  ).toEqual(main);
  expect(
    await f.invoke("getById", {
      windowId: "unknown",
    }),
  ).toBeNull();
  expect(
    await f.invoke("getById", {
      windowId: "main",
    }),
  ).toBeNull();
  expect(
    await f.invoke("getById", {
      windowId: privateWindow.windowId,
    }),
  ).toEqual(privateWindow);
  expect(await f.invoke("getCurrent", null, "view:private")).toEqual(
    privateWindow,
  );
  f.activate(privateWindow);
  expect(await f.invoke("getFocused")).toEqual(privateWindow);
  expect(await f.invoke("getLastActive")).toEqual(privateWindow);
  f.identities.set("main", {
    windowId: "window-new",
    viewId: "main",
  });
  expect(
    await f.invoke("getById", {
      windowId: main.windowId,
    }),
  ).toBeNull();
  expect(await f.invoke("getCurrent")).toEqual({
    windowId: "window-new",
    viewId: "main",
  });
  f.closed.add("main");
  expect(
    await f.invoke("getById", {
      windowId: "window-new",
    }),
  ).toBeNull();
});

test("lookup requires its own operation grant, handles cancellation and explicitly rejects unsupported platforms", async () => {
  const f = fixture();
  f.permissions.permissions = [];
  for (const name of queries) {
    await expect(
      f.invoke(
        name,
        name === "getById"
          ? {
              windowId: main.windowId,
            }
          : null,
      ),
    ).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
  }
  f.permissions.permissions = windowPermissions();
  delete f.services.lookup;
  await expect(f.invoke("getFocused")).rejects.toMatchObject({
    code: "UNSUPPORTED",
  });
  f.cancel();
  await expect(f.invoke("getCurrent")).rejects.toMatchObject({
    code: "CANCELLED",
  });
});

test("a lookup grant covers declared targets but grants no control or other lookup", async () => {
  const f = fixture();
  f.permissions.permissions = [
    "windows.getById",
  ];
  expect(
    await f.invoke("getById", {
      windowId: main.windowId,
    }),
  ).toEqual(main);
  expect(
    await f.invoke("getById", {
      windowId: privateWindow.windowId,
    }),
  ).toEqual(privateWindow);
  await expect(f.invoke("getCurrent")).rejects.toMatchObject({
    code: "PERMISSION_DENIED",
  });
  await expect(
    f.invoke("isDestroyed", {
      view: "main",
    }),
  ).rejects.toMatchObject({
    code: "PERMISSION_DENIED",
  });
});

test("destroyed handles deferred and closing windows and rejects unknown views", async () => {
  const f = fixture({
    ready: false,
  });
  expect(await f.invoke("getCurrent")).toEqual(main);
  expect(
    await f.invoke("isDestroyed", {
      view: "main",
    }),
  ).toBe(false);
  expect(
    await f.invoke("isDestroyed", {
      view: "deferred",
    }),
  ).toBe(true);
  f.closed.add("main");
  expect(
    await f.invoke("isDestroyed", {
      view: "main",
    }),
  ).toBe(true);
  expect(
    await f.invoke("isDestroyed", {
      view: "private",
    }),
  ).toBe(false);
  await expect(
    f.invoke("isDestroyed", {
      view: "undeclared",
    }),
  ).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  });
  f.cancel();
  await expect(
    f.invoke("isDestroyed", {
      view: "main",
    }),
  ).rejects.toMatchObject({
    code: "CANCELLED",
  });
});
