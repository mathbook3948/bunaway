import { expect, test } from "bun:test";
import type {
  NativeWindow,
  NativeWindowServices,
} from "@bunaway/plugin-api/native";
import {
  validateWindowCall,
  validateWindowOutput,
  windowsPlugin,
} from "@bunaway/plugin-windows";
import { type JsonValue, NativeRegistry, type Policy } from "@bunaway/protocol";
import { createOperations } from "#plugins/windows/src/windows";

const allGrants: Policy["backend"] = {
  permissions: [
    {
      identifier: "windows:control",
      allow: [
        {
          view: "main",
        },
        {
          view: "child",
        },
      ],
    },
    {
      identifier: "windows:destroy",
      allow: [
        {
          view: "child",
        },
      ],
    },
  ],
};

function fixture() {
  const calls: unknown[] = [];
  const unused = (): never => {
    throw new Error("Unexpected native call");
  };
  let cancelled = false;
  const native: NativeWindow = {
    show: unused,
    showInactive: unused,
    focus: unused,
    activate: unused,
    close: () => {
      calls.push("close");
      return false;
    },
    destroy: () => {
      calls.push("destroy");
      return true;
    },
    setParent: (parent, modal) => {
      calls.push({
        parent,
        modal,
      });
    },
    getParent: () => ({
      windowId: "window-main",
      viewId: "main",
    }),
    getChildren: () => [
      {
        windowId: "window-child",
        viewId: "child",
      },
    ],
    setEnabled: (enabled) => {
      calls.push(enabled);
    },
    isEnabled: () => false,
    getSnapshot: unused,
    getReadiness: unused,
    minimize: unused,
    maximize: unused,
    unmaximize: unused,
    restore: unused,
    toggleMaximize: unused,
    isMinimized: unused,
    isMaximized: unused,
    isFullscreen: unused,
    getBounds: unused,
    getDpi: unused,
    isVisible: unused,
    isFocused: unused,
    getSizeConstraints: unused,
    setSizeConstraints: unused,
    setSize: unused,
    setPosition: unused,
    setGeometry: unused,
    setFullscreen: unused,
    setCloseConfirmation: unused,
  };
  const services: NativeWindowServices = {
    specs: [
      "main",
      "child",
    ].map((view) => ({
      view,
      title: view,
      home: "https://app.bunaway.local",
      window: {
        width: 400,
        height: 300,
      },
    })),
    lookup: {
      byId: (id) =>
        id === "window-main"
          ? {
              windowId: id,
              viewId: "main",
            }
          : null,
      byView: unused,
      focused: unused,
      lastActive: unused,
    },
    read: () => ({
      closed: false,
      cleaned: false,
      ready: true,
      failure: null,
      deadline: Infinity,
    }),
    window: () => native,
    create: unused,
    close: unused,
    stopping: () => false,
    cancelled: () => cancelled,
    now: Date.now,
    tick: async () => {},
  };
  const execute = createOperations({
    dataRoot: ".",
    capabilities: [],
    windows: services,
  }).executeUI;
  if (!execute) {
    throw new Error("Missing UI executor");
  }
  return {
    calls,
    cancel: () => {
      cancelled = true;
    },
    invoke: (
      name: string,
      input: JsonValue,
      source = "backend",
      permissions = allGrants,
    ) =>
      Promise.resolve().then(() =>
        execute(`windows.${name}`, input, source, {
          requestId: "request",
          permissions,
        }),
      ),
  };
}

test("trusted destroy requires authenticated backend origin, dedicated grant and target control", async () => {
  const f = fixture();
  const input = {
    view: "child",
  };
  const [controlPermission, destroyPermission] = allGrants.permissions;
  if (!controlPermission || !destroyPermission) {
    throw new Error("Missing test permissions");
  }
  expect(await f.invoke("close", input)).toBe(false);
  expect(await f.invoke("destroy", input)).toBe(true);
  await expect(f.invoke("destroy", input, "view:main")).rejects.toMatchObject({
    code: "PERMISSION_DENIED",
  });
  await expect(
    f.invoke("destroy", input, "backend", {
      permissions: [
        controlPermission,
      ],
    }),
  ).rejects.toMatchObject({
    code: "PERMISSION_DENIED",
  });
  await expect(
    f.invoke("destroy", input, "backend", {
      permissions: [
        destroyPermission,
      ],
    }),
  ).rejects.toMatchObject({
    code: "PERMISSION_DENIED",
  });
  expect(f.calls).toEqual([
    "close",
    "destroy",
  ]);
  f.cancel();
  await expect(f.invoke("destroy", input)).rejects.toMatchObject({
    code: "CANCELLED",
  });
});

test("ownership requires both target grants, hides denied identities and rejects expired IDs", async () => {
  const f = fixture();
  const childOnly: Policy["backend"] = {
    permissions: [
      {
        identifier: "windows:control",
        allow: [
          {
            view: "child",
          },
        ],
      },
    ],
  };
  await expect(
    f.invoke(
      "setParent",
      {
        view: "child",
        parent: "window-main",
        modal: true,
      },
      "backend",
      childOnly,
    ),
  ).rejects.toMatchObject({
    code: "PERMISSION_DENIED",
  });
  await expect(
    f.invoke("setParent", {
      view: "child",
      parent: "expired-main",
      modal: true,
    }),
  ).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  });
  await expect(
    f.invoke(
      "setParent",
      {
        view: "child",
        parent: null,
        modal: false,
      },
      "backend",
      childOnly,
    ),
  ).rejects.toMatchObject({
    code: "PERMISSION_DENIED",
  });
  expect(
    await f.invoke(
      "getParent",
      {
        view: "child",
      },
      "backend",
      childOnly,
    ),
  ).toBeNull();
  expect(
    await f.invoke("getOwner", {
      view: "child",
    }),
  ).toEqual({
    windowId: "window-main",
    viewId: "main",
  });
  await f.invoke("setParent", {
    view: "child",
    parent: "window-main",
    modal: true,
  });
  expect(f.calls).toEqual([
    {
      parent: "window-main",
      modal: true,
    },
  ]);
  expect(
    await f.invoke("getChildren", {
      view: "main",
    }),
  ).toHaveLength(1);
  await f.invoke("setEnabled", {
    view: "main",
    enabled: false,
  });
  expect(
    await f.invoke("isEnabled", {
      view: "main",
    }),
  ).toBe(false);
});

test("ownership and enabled contracts reject malformed external inputs and outputs", () => {
  const registry = new NativeRegistry([
    windowsPlugin,
  ]);
  expect(registry.operation("windows.destroy").permission).toBe(
    "windows:destroy",
  );
  for (const input of [
    {
      view: "child",
      parent: "main",
      modal: "true",
    },
    {
      view: "child",
      parent: "main",
    },
    {
      view: "child",
      parent: 1,
      modal: false,
    },
    {
      view: "child",
      parent: null,
      modal: false,
      force: true,
    },
  ]) {
    expect(() =>
      validateWindowCall({
        operation: "windows.setParent",
        payload: input,
      }),
    ).toThrow();
  }
  expect(() =>
    validateWindowCall({
      operation: "windows.setEnabled",
      payload: {
        view: "main",
        enabled: 1,
      },
    }),
  ).toThrow();
  expect(() =>
    validateWindowOutput("windows.getParent", {
      view: "main",
    }),
  ).toThrow();
  expect(() => validateWindowOutput("windows.destroy", null)).toThrow();
});
