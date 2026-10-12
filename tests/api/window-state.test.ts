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
  };
  let failure: Error | undefined;
  let title = "Declared title";
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
    setTitle(value) {
      apply("setTitle");
      title = value;
    },
    getTitle: () => title,
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
        | "getTitle"
        | "setTitle",
      view = "main",
      payload: {
        title?: string;
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

test("title operations preserve Unicode, enforce bounded input, individual permissions and window lifetime", async () => {
  const f = fixture();
  expect(await f.invoke("getTitle")).toBe("Declared title");
  for (const title of [
    "새 문서 📝",
    "x".repeat(1024),
    "📝".repeat(512),
  ]) {
    expect(
      validateWindowCall({
        operation: "windows.setTitle",
        payload: {
          view: "main",
          windowId: "window-1",
          title,
        },
      }).payload,
    ).toEqual({
      view: "main",
      windowId: "window-1",
      title,
    });
    expect(
      await f.invoke("setTitle", "main", {
        title,
      }),
    ).toBeNull();
    expect(await f.invoke("getTitle")).toBe(title);
    expect(validateWindowOutput("windows.getTitle", title)).toBe(title);
  }
  for (const title of [
    "",
    "bad\0title",
    "x".repeat(1025),
    "📝".repeat(513),
    42,
    null,
  ]) {
    expect(() =>
      validateWindowCall({
        operation: "windows.setTitle",
        payload: {
          view: "main",
          title,
        },
      }),
    ).toThrow();
  }
  expect(() =>
    validateWindowCall({
      operation: "windows.getTitle",
      payload: {
        view: "main",
        title: "extra",
      },
    }),
  ).toThrow();
  expect(() =>
    validateWindowOutput("windows.getTitle", "x".repeat(1025)),
  ).toThrow();
  expect(() => validateWindowOutput("windows.getTitle", null)).toThrow();
  expect(validateWindowOutput("windows.getTitle", "")).toBe("");
  expect(validateWindowOutput("windows.setTitle", null)).toBeNull();
  expect(() => validateWindowOutput("windows.setTitle", true)).toThrow();
  f.permissions.permissions = [
    "windows.getTitle",
  ];
  await expect(
    f.invoke("setTitle", "main", {
      title: "Denied",
    }),
  ).rejects.toMatchObject({
    code: "PERMISSION_DENIED",
  });
  f.permissions.permissions = [
    "windows.setTitle",
  ];
  await expect(f.invoke("getTitle")).rejects.toMatchObject({
    code: "PERMISSION_DENIED",
  });
  f.permissions.permissions = windowPermissions();
  await expect(
    f.invoke("setTitle", "missing", {
      title: "Missing",
    }),
  ).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  });
  f.setClosed();
  for (const operation of [
    "setTitle",
    "getTitle",
  ] as const) {
    await expect(
      f.invoke(
        operation,
        "main",
        operation === "setTitle"
          ? {
              title: "Closed",
            }
          : {},
      ),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  }
  expect(f.actions).toHaveLength(3);
  for (const operation of [
    "setTitle",
    "getTitle",
  ] as const) {
    const unsupported = fixture();
    delete unsupported.native[operation];
    await expect(
      unsupported.invoke(
        operation,
        "main",
        operation === "setTitle"
          ? {
              title: "Unsupported",
            }
          : {},
      ),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
  }
  const failed = fixture();
  failed.setFailure(new Error("Title change failed"));
  await expect(
    failed.invoke("setTitle", "main", {
      title: "Failed",
    }),
  ).rejects.toThrow("Title change failed");
  expect(await failed.invoke("getTitle")).toBe("Declared title");
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
