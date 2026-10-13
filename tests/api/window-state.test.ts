import { expect, test } from "bun:test";
import { windowPermissions } from "../fixtures/window-permissions.ts";
import type {
  NativeWindow,
  NativeWindowServices,
} from "@bunaway/plugin-api/native";
import {
  validateWindowCall,
  validateWindowOutput,
  windowOperations,
  windowsPlugin,
} from "@bunaway/plugin-windows";
import { NativeRegistry, type Policy } from "@bunaway/protocol";
import { createOperations } from "#plugins/windows/src/platforms/windows";

const controls = [
  "minimize",
  "maximize",
  "unmaximize",
  "restore",
  "toggleMaximize",
] as const;
const queries = [
  "isMinimized",
  "isMaximized",
  "isFullscreen",
  "isVisible",
  "isFocused",
] as const;
const registry = new NativeRegistry([
  windowsPlugin,
]);
const stateQueries = [
  ...queries,
  "isFocusable",
  "isResizable",
  "isMovable",
  "isNormal",
  "isDestroyed",
] as const;

test("window state schemas accept only a view and validate null or boolean outputs", () => {
  for (const name of [
    ...controls,
    ...stateQueries,
  ]) {
    const operation = `windows.${name}` as const;
    expect(windowOperations[operation]).toBeDefined();
    expect(registry.operation(operation).name).toBe(operation);
    expect(
      validateWindowCall({
        operation,
        payload: {
          view: "main",
        },
      }),
    ).toEqual({
      operation,
      payload: {
        view: "main",
      },
    });
    for (const payload of [
      null,
      {},
      {
        view: "",
      },
      {
        view: "main\n",
      },
      {
        view: 1,
      },
      {
        view: "main",
        force: true,
      },
    ]) {
      expect(() =>
        validateWindowCall({
          operation,
          payload,
        }),
      ).toThrow();
    }
  }
  for (const name of controls) {
    expect(validateWindowOutput(`windows.${name}`, null)).toBeNull();
    expect(() => validateWindowOutput(`windows.${name}`, true)).toThrow();
  }
  for (const name of stateQueries) {
    for (const value of [
      false,
      true,
    ]) {
      expect(validateWindowOutput(`windows.${name}`, value)).toBe(value);
    }
    for (const value of [
      null,
      0,
      "false",
      {
        value: false,
      },
    ]) {
      expect(() => validateWindowOutput(`windows.${name}`, value)).toThrow();
    }
  }
});

/** Supply explicit native resources while keeping permission and lifecycle dispatch real. */
function fixture() {
  const actions: string[] = [];
  let closed = false;
  let fullscreen = false;
  const observed = {
    isMinimized: false,
    isMaximized: false,
    isVisible: false,
    isFocused: false,
    isFocusable: true,
    isResizable: true,
    isMovable: true,
  };
  let failure: Error | undefined;
  const native: NativeWindow = {
    getReadiness() {
      throw new Error("Readiness is not used in this state test.");
    },
    getSnapshot() {
      throw new Error("Snapshot is not used in this state test.");
    },
    show() {},
    showInactive() {},
    activate: () => true,
    focus: () => true,
    close: () => true,
    minimize: () => apply("minimize"),
    maximize: () => apply("maximize"),
    unmaximize: () => apply("unmaximize"),
    restore: () => apply("restore"),
    toggleMaximize: () => apply("toggleMaximize"),
    isMinimized: () => observed.isMinimized,
    isMaximized: () => observed.isMaximized,
    isFullscreen: () => fullscreen,
    isVisible: () => observed.isVisible,
    isFocused: () => observed.isFocused,
    getDpi: () => 96,
    getBounds: () => ({
      x: 0,
      y: 0,
      width: 800,
      height: 600,
      dpi: 96,
    }),
    getSizeConstraints: () => ({
      minWidth: null,
      minHeight: null,
      maxWidth: null,
      maxHeight: null,
    }),
    setSizeConstraints() {},
    setSize() {},
    setPosition() {},
    setFocusable(value) {
      apply("setFocusable");
      observed.isFocusable = value;
    },
    isFocusable: () => observed.isFocusable,
    setResizable(resizable) {
      apply("setResizable");
      observed.isResizable = resizable;
    },
    isResizable: () => observed.isResizable,
    setMovable(movable) {
      apply("setMovable");
      observed.isMovable = movable;
    },
    isMovable: () => observed.isMovable,
    setGeometry() {},
    setFullscreen() {},
    setCloseConfirmation() {},
  };
  function apply(action: string) {
    if (failure) {
      throw failure;
    }
    actions.push(action);
  }
  const services: NativeWindowServices = {
    specs: [
      "main",
      "private",
    ].map((view) => ({
      view,
      title: view,
      home: "https://app.bunaway.local",
      window: {
        width: 800,
        height: 600,
      },
    })),
    read: () => ({
      closed,
      cleaned: false,
      ready: true,
      failure: null,
      deadline: Infinity,
    }),
    create() {},
    close: () => true,
    window: () => native,
    stopping: () => false,
    cancelled: () => false,
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
    native,
    actions,
    permissions,
    invoke: (
      name:
        | (typeof controls)[number]
        | (typeof stateQueries)[number]
        | "setFocusable"
        | "setResizable"
        | "setMovable",
      view = "main",
      payload: {
        focusable?: boolean;
        resizable?: boolean;
        movable?: boolean;
      } = {},
    ) =>
      Promise.resolve().then(() =>
        execute(
          `windows.${name}`,
          {
            view,
            ...payload,
          },
          "backend",
          {
            requestId: name,
            permissions,
          },
        ),
      ),
    setClosed: () => {
      closed = true;
    },
    setFullscreen: () => {
      fullscreen = true;
    },
    setObserved: (name: keyof typeof observed, value: boolean) => {
      observed[name] = value;
    },
    setFailure: (error: Error) => {
      failure = error;
    },
  };
}

test("focusability validates booleans and keeps activation policy separate from observed focus and operation grants", async () => {
  const f = fixture();
  expect(await f.invoke("isFocusable")).toBe(true);
  for (const focusable of [
    false,
    true,
    false,
  ]) {
    const payload = {
      focusable,
    };
    expect(
      validateWindowCall({
        operation: "windows.setFocusable",
        payload: {
          view: "main",
          windowId: "window-1",
          ...payload,
        },
      }).operation,
    ).toBe("windows.setFocusable");
    expect(await f.invoke("setFocusable", "main", payload)).toBeNull();
    expect(await f.invoke("isFocusable")).toBe(focusable);
    expect(await f.invoke("isFocused")).toBe(false);
  }
  for (const payload of [
    {},
    {
      focusable: null,
    },
    {
      focusable: 1,
    },
    {
      focusable: "false",
    },
    {
      focusable: true,
      extra: true,
    },
  ]) {
    expect(() =>
      validateWindowCall({
        operation: "windows.setFocusable",
        payload: {
          view: "main",
          ...payload,
        },
      }),
    ).toThrow();
  }
  f.permissions.permissions = [
    "windows.isFocusable",
  ];
  await expect(
    f.invoke("setFocusable", "main", {
      focusable: true,
    }),
  ).rejects.toMatchObject({
    code: "PERMISSION_DENIED",
  });
  f.permissions.permissions = windowPermissions();
  await expect(
    f.invoke("setFocusable", "missing", {
      focusable: true,
    }),
  ).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  });
  f.setClosed();
  await expect(
    f.invoke("setFocusable", "main", {
      focusable: true,
    }),
  ).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  });
  expect(f.actions).toHaveLength(3);
  const unsupported = fixture();
  delete unsupported.native.setFocusable;
  await expect(
    unsupported.invoke("setFocusable", "main", {
      focusable: true,
    }),
  ).rejects.toMatchObject({
    code: "UNSUPPORTED",
  });
});

test("user movement controls validate booleans and keep per-operation grants and lifetime checks", async () => {
  for (const [setter, getter, field] of [
    [
      "setResizable",
      "isResizable",
      "resizable",
    ],
    [
      "setMovable",
      "isMovable",
      "movable",
    ],
  ] as const) {
    const f = fixture();
    expect(await f.invoke(getter)).toBe(true);
    for (const value of [
      false,
      true,
      false,
    ]) {
      const payload = {
        [field]: value,
      };
      expect(
        validateWindowCall({
          operation: `windows.${setter}`,
          payload: {
            view: "main",
            windowId: "window-1",
            ...payload,
          },
        }).operation,
      ).toBe(`windows.${setter}`);
      expect(await f.invoke(setter, "main", payload)).toBeNull();
      expect(await f.invoke(getter)).toBe(value);
    }
    for (const payload of [
      {},
      {
        [field]: null,
      },
      {
        [field]: 1,
      },
      {
        [field]: "false",
      },
      {
        [field]: true,
        extra: true,
      },
    ]) {
      expect(() =>
        validateWindowCall({
          operation: `windows.${setter}`,
          payload: {
            view: "main",
            ...payload,
          },
        }),
      ).toThrow();
    }
    expect(validateWindowOutput(`windows.${setter}`, null)).toBeNull();
    expect(() => validateWindowOutput(`windows.${setter}`, true)).toThrow();
    f.permissions.permissions = [
      `windows.${getter}`,
    ];
    await expect(
      f.invoke(setter, "main", {
        [field]: true,
      }),
    ).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
    f.permissions.permissions = windowPermissions();
    await expect(
      f.invoke(setter, "missing", {
        [field]: true,
      }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    f.setClosed();
    await expect(
      f.invoke(setter, "main", {
        [field]: true,
      }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    expect(f.actions).toHaveLength(3);
    const unsupported = fixture();
    delete unsupported.native[setter];
    await expect(
      unsupported.invoke(setter, "main", {
        [field]: true,
      }),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
    const failed = fixture();
    failed.setFailure(new Error("Movement failed"));
    await expect(
      failed.invoke(setter, "main", {
        [field]: false,
      }),
    ).rejects.toThrow("Movement failed");
  }
});

test("state dispatch uses live resource queries and rejects fullscreen changes without mutation", async () => {
  const f = fixture();
  for (const name of controls) {
    expect(await f.invoke(name)).toBeNull();
  }
  expect(f.actions).toEqual([
    ...controls,
  ]);
  for (const value of [
    false,
    true,
    false,
  ]) {
    for (const name of queries.filter((query) => query !== "isFullscreen")) {
      f.setObserved(name, value);
      expect(await f.invoke(name)).toBe(value);
      for (const other of queries.filter(
        (query) => query !== "isFullscreen" && query !== name,
      )) {
        expect(await f.invoke(other)).toBe(false);
      }
      f.setObserved(name, false);
    }
  }
  f.setFullscreen();
  expect(await f.invoke("isFullscreen")).toBe(true);
  for (const name of controls) {
    await expect(f.invoke(name)).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  }
  expect(f.actions).toEqual([
    ...controls,
  ]);
});

test("every state call enforces operation permission and open configured windows", async () => {
  for (const name of [
    ...controls,
    ...stateQueries,
  ]) {
    const f = fixture();
    f.permissions.permissions = [];
    for (const view of [
      "private",
      "ungranted",
    ]) {
      expect(
        registry.allowed(
          {
            permissions: [],
          },
          {
            operation: `windows.${name}`,
            payload: {
              view,
            },
          },
        ),
      ).toBe(false);
      await expect(f.invoke(name, view)).rejects.toMatchObject({
        code: "PERMISSION_DENIED",
      });
    }
    f.permissions.permissions = windowPermissions();
    await expect(f.invoke(name, "undeclared")).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    f.setClosed();
    if (name === "isDestroyed") {
      expect(await f.invoke(name)).toBe(true);
    } else {
      await expect(f.invoke(name)).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
      });
    }
    expect(f.actions).toEqual([]);
  }
});

test("native failures propagate from state operations", async () => {
  const f = fixture();
  const failure = new Error("Native operation failed.");
  f.setFailure(failure);
  for (const name of controls) {
    await expect(f.invoke(name)).rejects.toBe(failure);
  }
  expect(f.actions).toEqual([]);
});

test("normal excludes minimized, maximized and fullscreen but not hidden or unfocused windows", async () => {
  const f = fixture();
  expect(await f.invoke("isNormal")).toBe(true);
  expect(await f.invoke("isDestroyed")).toBe(false);
  for (const name of [
    "isMinimized",
    "isMaximized",
  ] as const) {
    f.setObserved(name, true);
    expect(await f.invoke("isNormal")).toBe(false);
    f.setObserved(name, false);
    expect(await f.invoke("isNormal")).toBe(true);
  }
  f.setFullscreen();
  expect(await f.invoke("isNormal")).toBe(false);
  f.setClosed();
  expect(await f.invoke("isDestroyed")).toBe(true);
  await expect(f.invoke("isNormal")).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  });
  expect(f.actions).toEqual([]);
});
