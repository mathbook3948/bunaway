import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import type {
  NativeWindowServices,
  WindowIdentity,
  WindowSpec,
  WindowState,
} from "@bunaway/plugin-api/native";
import {
  validateWindowCall,
  validateWindowOutput,
  windowsPlugin,
} from "@bunaway/plugin-windows";
import {
  BunawayError,
  type JsonValue,
  NativeRegistry,
} from "@bunaway/protocol";
import { WindowOperations } from "#plugins/windows/src/coordinator";
import { createOperations } from "#plugins/windows/src/platforms/windows";
import { windowPermissions } from "../fixtures/window-permissions.ts";

/** A native owner fixture keeps old cleanup separate from public identity removal and creation completion. */
function fixture(validateCreation?: (spec: WindowSpec) => void) {
  const specs: WindowSpec[] = (
    [
      {
        view: "editor",
        instances: "multiple",
        maxInstances: 2,
      },
      {
        view: "other",
        instances: "multiple",
        maxInstances: 128,
      },
      {
        view: "main",
      },
    ] satisfies Pick<WindowSpec, "view" | "instances" | "maxInstances">[]
  ).map((entry) => ({
    ...entry,
    title: entry.view,
    home: "https://app.bunaway.local",
    window: {
      width: 800,
      height: 600,
    },
  }));
  const entries = new Map<
    string,
    {
      identity: WindowIdentity;
      state: WindowState;
      spec: WindowSpec;
    }
  >();
  const calls: string[] = [];
  let sequence = 0;
  let ready = true;
  let tick = async () => {
    for (const entry of entries.values()) {
      if (entry.state.closed) {
        entry.state.cleaned = true;
      }
    }
  };
  const services: NativeWindowServices = {
    specs,
    supportsCreationOptions: true,
    ...(validateCreation
      ? {
          validateCreation,
        }
      : {}),
    instances: () =>
      [
        ...entries,
      ].map(([key, entry]) => ({
        key,
        identity: entry.identity,
      })),
    lookup: {
      byId: (id) =>
        [
          ...entries.values(),
        ].find((entry) => entry.identity.windowId === id && !entry.state.closed)
          ?.identity ?? null,
      byView: (id) =>
        [
          ...entries.values(),
        ].find((entry) => entry.identity.viewId === id && !entry.state.closed)
          ?.identity ?? null,
      byRequest: (request) => entries.get(request)?.identity ?? null,
      focused: () => null,
      lastActive: () => null,
    },
    read: (key) => entries.get(key)?.state,
    create(spec, _replacing, key = spec.view) {
      entries.delete(key);
      entries.set(key, {
        identity: {
          windowId: `window-${++sequence}`,
          viewId: spec.view,
        },
        spec,
        state: {
          closed: false,
          cleaned: false,
          ready,
          failure: undefined,
          deadline: Infinity,
        },
      });
    },
    close: (key) => {
      const entry = entries.get(key);
      assert(entry);
      calls.push(`close:${key}`);
      entry.state.closed = true;
      return true;
    },
    destroy: (key) => {
      const entry = entries.get(key);
      assert(entry);
      calls.push(`destroy:${key}`);
      entry.state.closed = true;
      return true;
    },
    window: () => {
      throw new Error("Identity queries must not call native window controls.");
    },
    stopping: () => false,
    cancelled: () => false,
    now: () => 0,
    tick: () => tick(),
  };
  const operations = new WindowOperations(specs, {
    ...services,
    apply: (_call, key) => {
      calls.push(`apply:${key}`);
      return null;
    },
  });

  const execute = (operation: string, payload: JsonValue) =>
    operations.execute(
      validateWindowCall({
        operation,
        payload,
      }),
      "request",
    );
  return {
    operations,
    services,
    entries,
    calls,
    execute,
    setReady: (value: boolean) => {
      ready = value;
    },
    setTick: (value: () => Promise<void>) => {
      tick = value;
    },
  };
}

const editor = {
  view: "editor",
};

test("instance placement preflight rejects before close or reservation and restores declaration defaults", async () => {
  const f = fixture((spec) => {
    if (spec.window.preventOverflow) {
      throw new BunawayError({
        code: "INVALID_ARGUMENT",
        message: "Minimum cannot fit.",
      });
    }
  });
  const options = {
    window: {
      x: -800,
      y: -100,
      useContentSize: false,
    },
  };
  const first = validateWindowOutput(
    "windows.createInstance",
    await f.execute("windows.createInstance", {
      ...editor,
      options,
    }),
  );
  const key = [
    ...f.entries,
  ].find(([, entry]) => entry.identity.windowId === first.windowId)?.[0];
  assert(key);
  expect(f.entries.get(key)?.spec.window).toMatchObject(options.window);
  for (const payload of [
    {
      ...editor,
      options: {
        window: {
          x: 0,
        },
      },
    },
    {
      ...editor,
      options: {
        window: {
          preventOverflow: true,
        },
      },
    },
  ]) {
    await expect(
      f.execute("windows.createInstance", payload),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    await expect(
      f.execute("windows.recreateInstance", {
        ...payload,
        windowId: first.windowId,
      }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    expect(f.operations.replacing.size).toBe(0);
    expect(f.entries.get(key)?.state.closed).toBe(false);
    expect(f.calls).toEqual([]);
    expect(f.entries.size).toBe(1);
  }
  const next = validateWindowOutput(
    "windows.recreateInstance",
    await f.execute("windows.recreateInstance", {
      ...editor,
      windowId: first.windowId,
    }),
  );
  expect(next.windowId).not.toBe(first.windowId);
  expect(f.entries.get(key)?.spec.window).toEqual({
    width: 800,
    height: 600,
  });
});
test("multiple instances return distinct IDs and require an explicit matching target even with one window", async () => {
  const f = fixture();
  const first = await f.execute("windows.createInstance", editor);
  const second = await f.execute("windows.createInstance", editor);
  const a = validateWindowOutput("windows.createInstance", first);
  const b = validateWindowOutput("windows.createInstance", second);
  expect(a.windowId).not.toBe(b.windowId);
  expect(a.viewId).toBe("editor");
  expect(await f.execute("windows.list", null)).toEqual([
    {
      view: "editor",
      open: true,
    },
    {
      view: "other",
      open: false,
    },
    {
      view: "main",
      open: false,
    },
  ]);
  expect(await f.execute("windows.listInstances", null)).toEqual([
    a,
    b,
  ]);
  await expect(f.execute("windows.show", editor)).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  });
  await expect(
    f.execute("windows.show", {
      view: "other",
      windowId: a.windowId,
    }),
  ).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  });
  await f.execute("windows.show", {
    ...editor,
    windowId: b.windowId,
  });
  const key = [
    ...f.entries,
  ].find(([, entry]) => entry.identity.windowId === b.windowId)?.[0];
  expect(f.calls).toEqual([
    `apply:${key}`,
  ]);
  await expect(f.execute("windows.create", editor)).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  });
  await expect(f.execute("windows.recreate", editor)).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  });
});

test("instance recreation replaces only the selected lifetime and rejects stale IDs", async () => {
  const f = fixture();
  const first = validateWindowOutput(
    "windows.createInstance",
    await f.execute("windows.createInstance", editor),
  );
  const second = validateWindowOutput(
    "windows.createInstance",
    await f.execute("windows.createInstance", editor),
  );
  const replacement = validateWindowOutput(
    "windows.recreateInstance",
    await f.execute("windows.recreateInstance", {
      ...editor,
      windowId: first.windowId,
      options: {
        title: "Replaced",
      },
    }),
  );
  expect(replacement.windowId).not.toBe(first.windowId);
  expect(await f.execute("windows.listInstances", null)).toEqual([
    second,
    replacement,
  ]);
  await expect(
    f.execute("windows.show", {
      ...editor,
      windowId: first.windowId,
    }),
  ).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  });
  await expect(
    f.execute("windows.recreateInstance", {
      ...editor,
      windowId: first.windowId,
    }),
  ).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  });
  expect(
    await f.execute("windows.isDestroyed", {
      ...editor,
      windowId: first.windowId,
    }),
  ).toBe(true);
  const entry = [
    ...f.entries.values(),
  ].find((entry) => entry.identity.windowId === replacement.windowId);
  expect(entry?.spec.title).toBe("Replaced");
  expect(f.calls.filter((call) => call.startsWith("close:"))).toHaveLength(1);
});

test("simultaneous creation is independent while active, preparing and cleaning instances enforce limits", async () => {
  const f = fixture();
  f.setReady(false);
  const wakes: (() => void)[] = [];
  f.setTick(
    () =>
      new Promise<void>((resolve) => {
        wakes.push(resolve);
      }),
  );
  const first = f.execute("windows.createInstance", editor);
  const second = f.execute("windows.createInstance", editor);
  expect(f.entries.size).toBe(2);
  await expect(
    f.execute("windows.createInstance", editor),
  ).rejects.toMatchObject({
    code: "BUSY",
  });
  for (const entry of f.entries.values()) {
    entry.state.ready = true;
  }
  for (const wake of wakes.splice(0)) {
    wake();
  }
  await Promise.all([
    first,
    second,
  ]);
  const entry = f.entries.values().next().value;
  assert(entry);
  entry.state.closed = true;
  await expect(
    f.execute("windows.createInstance", editor),
  ).rejects.toMatchObject({
    code: "BUSY",
  });
  expect(await f.execute("windows.listInstances", null)).toHaveLength(1);
  await expect(f.execute("windows.show", editor)).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  });
  entry.state.cleaned = true;
  f.setReady(true);
  expect(
    validateWindowOutput(
      "windows.createInstance",
      await f.execute("windows.createInstance", editor),
    ).windowId,
  ).toBe("window-3");
});

test("global active and cleaning native resources are bounded independently of view limits", async () => {
  const f = fixture();
  for (let index = 0; index < 128; index++) {
    await f.execute("windows.createInstance", {
      view: "other",
    });
  }
  await expect(
    f.execute("windows.createInstance", editor),
  ).rejects.toMatchObject({
    code: "BUSY",
  });
  const entry = f.entries.values().next().value;
  assert(entry);
  entry.state.closed = true;
  await expect(
    f.execute("windows.createInstance", editor),
  ).rejects.toMatchObject({
    code: "BUSY",
  });
  entry.state.cleaned = true;
  await f.execute("windows.createInstance", editor);
  expect(await f.execute("windows.listInstances", null)).toHaveLength(128);
});

test("identity creation preserves single-window compatibility and validation precedes close", async () => {
  const f = fixture();
  const identity = validateWindowOutput(
    "windows.createInstance",
    await f.execute("windows.createInstance", {
      view: "main",
    }),
  );
  await expect(
    f.execute("windows.create", {
      view: "main",
    }),
  ).rejects.toMatchObject({
    code: "BUSY",
  });
  await expect(
    f.execute("windows.recreateInstance", {
      view: "main",
      windowId: identity.windowId,
      options: {
        window: {
          minWidth: 900,
          maxWidth: 800,
        },
      },
    }),
  ).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  });
  expect(f.calls).toEqual([]);
  expect(
    await f.execute("windows.recreate", {
      view: "main",
    }),
  ).toBeNull();
  await expect(
    f.execute("windows.completeSplashscreen", {
      view: "main",
      splash: "editor",
    }),
  ).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  });
});

test("getCurrent uses authenticated request ownership rather than the first window of a view", async () => {
  const f = fixture();
  const one = validateWindowOutput(
    "windows.createInstance",
    await f.execute("windows.createInstance", editor),
  );
  const two = validateWindowOutput(
    "windows.createInstance",
    await f.execute("windows.createInstance", editor),
  );
  const adapter = createOperations({
    windows: f.services,
    dataRoot: "/tmp/window-instances-unused",
    capabilities: [],
  });
  const permissions = {
    permissions: windowPermissions(),
  };
  const registry = new NativeRegistry([
    windowsPlugin,
  ]);
  expect(registry.operation("windows.listInstances").name).toBe(
    "windows.listInstances",
  );
  for (const [key, entry] of f.entries) {
    expect(
      await adapter.executeUI?.("windows.getCurrent", null, "view:editor", {
        requestId: key,
        permissions,
      }),
    ).toEqual(entry.identity);
  }
  expect(
    await adapter.executeUI?.(
      "windows.getById",
      {
        windowId: two.windowId,
      },
      "backend",
      {
        requestId: "backend",
        permissions,
      },
    ),
  ).toEqual(two);
  expect(
    await adapter.executeUI?.("windows.getCurrent", null, "backend", {
      requestId: "backend",
      permissions,
    }),
  ).toBeNull();
  expect(one.windowId).not.toBe(two.windowId);
});

test("recreating one instance reserves its own slot while another instance remains controllable", async () => {
  const f = fixture();
  const first = validateWindowOutput(
    "windows.createInstance",
    await f.execute("windows.createInstance", editor),
  );
  const second = validateWindowOutput(
    "windows.createInstance",
    await f.execute("windows.createInstance", editor),
  );
  let wake: (() => void) | undefined;
  f.setTick(
    () =>
      new Promise<void>((resolve) => {
        wake = resolve;
      }),
  );
  const recreation = f.execute("windows.recreateInstance", {
    ...editor,
    windowId: first.windowId,
  });
  await Promise.resolve();
  assert(wake);
  await expect(
    f.execute("windows.recreateInstance", {
      ...editor,
      windowId: first.windowId,
    }),
  ).rejects.toMatchObject({
    code: "BUSY",
  });
  await f.execute("windows.show", {
    ...editor,
    windowId: second.windowId,
  });
  await expect(
    f.execute("windows.createInstance", editor),
  ).rejects.toMatchObject({
    code: "BUSY",
  });
  const original = [
    ...f.entries.values(),
  ].find((entry) => entry.identity.windowId === first.windowId);
  assert(original);
  original.state.cleaned = true;
  wake();
  expect(
    validateWindowOutput("windows.recreateInstance", await recreation).windowId,
  ).not.toBe(first.windowId);
  expect(f.operations.replacing.size).toBe(0);
});

test("listing enforces list permission and getCurrent rejects a forged view source", async () => {
  const f = fixture();
  await f.execute("windows.createInstance", editor);
  const [key] = f.entries.keys();
  assert(key);
  const adapter = createOperations({
    windows: f.services,
    capabilities: [],
    dataRoot: "/tmp/window-instances-unused",
  });
  await expect(
    Promise.resolve().then(() =>
      adapter.executeUI?.("windows.listInstances", null, "backend", {
        requestId: key,
        permissions: {
          permissions: [
            "windows.getCurrent",
          ],
        },
      }),
    ),
  ).rejects.toMatchObject({
    code: "PERMISSION_DENIED",
  });
  await expect(
    Promise.resolve().then(() =>
      adapter.executeUI?.("windows.getCurrent", null, "view:main", {
        requestId: key,
        permissions: {
          permissions: windowPermissions(),
        },
      }),
    ),
  ).rejects.toMatchObject({
    code: "PERMISSION_DENIED",
  });
  expect(
    await adapter.executeUI?.("windows.listInstances", null, "backend", {
      requestId: key,
      permissions: {
        permissions: [
          "windows.listInstances",
        ],
      },
    }),
  ).toEqual(
    [
      ...f.entries.values(),
    ].map(({ identity }) => identity),
  );
});
