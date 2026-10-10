import { expect, test } from "bun:test";
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
import { matches } from "#plugins/windows/src/scope";
import { createOperations } from "#plugins/windows/src/windows";

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

test("window state schemas accept only a view and validate null or boolean outputs", () => {
  for (const name of [
    ...controls,
    ...queries,
  ]) {
    const operation = `windows.${name}` as const;
    expect(windowOperations[operation]).toBeDefined();
    expect(registry.operation(operation).permission).toBe("windows:control");
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
  for (const name of queries) {
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
  const native: NativeWindow = {
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
      {
        identifier: "windows:control",
        allow: [
          {
            view: "main",
          },
          {
            view: "private",
          },
          {
            view: "undeclared",
          },
        ],
        deny: [
          {
            view: "private",
          },
        ],
      },
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
    actions,
    invoke: (
      name: (typeof controls)[number] | (typeof queries)[number],
      view = "main",
    ) =>
      Promise.resolve().then(() =>
        execute(
          `windows.${name}`,
          {
            view,
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

test("every state call enforces deny-first target permission and open configured windows", async () => {
  for (const name of [
    ...controls,
    ...queries,
  ]) {
    const f = fixture();
    for (const view of [
      "private",
      "ungranted",
    ]) {
      expect(
        registry.allowed(
          {
            permissions: [
              {
                identifier: "windows:control",
                allow: [
                  {
                    view,
                  },
                ],
                deny: [
                  {
                    view,
                  },
                ],
              },
            ],
          },
          {
            operation: `windows.${name}`,
            payload: {
              view,
            },
          },
          matches,
        ),
      ).toBe(false);
      await expect(f.invoke(name, view)).rejects.toMatchObject({
        code: "PERMISSION_DENIED",
      });
    }
    await expect(f.invoke(name, "undeclared")).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    f.setClosed();
    await expect(f.invoke(name)).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
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
