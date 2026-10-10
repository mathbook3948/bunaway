import { expect, test } from "bun:test";
import type {
  NativeWindow,
  NativeWindowServices,
  WindowState,
} from "@bunaway/plugin-api/native";
import {
  validateWindowCall,
  validateWindowOutput,
  windowsPlugin,
} from "@bunaway/plugin-windows";
import { NativeRegistry, type Policy } from "@bunaway/protocol";
import { createOperations } from "#plugins/windows/src/windows";

const names = [
  "showInactive",
  "blur",
  "activate",
] as const;

test("inactive display and activation contracts accept only a view and validate their actual results", () => {
  const registry = new NativeRegistry([
    windowsPlugin,
  ]);
  for (const name of names) {
    const operation = `windows.${name}` as const;
    expect(registry.operation(operation).permission).toBe("windows:control");
    expect(
      validateWindowCall({
        operation,
        payload: {
          view: "main",
        },
      }).payload,
    ).toEqual({
      view: "main",
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
    const outputs =
      name === "showInactive"
        ? [
            null,
          ]
        : [
            true,
            false,
          ];
    for (const value of outputs) {
      expect(validateWindowOutput(operation, value)).toBe(value);
    }
    for (const value of [
      0,
      "true",
      {},
      ...(name === "showInactive"
        ? [
            true,
          ]
        : [
            null,
          ]),
    ]) {
      expect(() => validateWindowOutput(operation, value)).toThrow();
    }
  }
});

/** Keep native outcomes explicit while exercising the real adapter, permissions and lifecycle. */
function fixture() {
  const views = [
    "main",
    "private",
    "editor",
    "reader",
  ];
  const calls: string[] = [];
  let focused = "main";
  let acceptsActivation = true;
  let failure: Error | undefined;
  const states = new Map<string, WindowState>(
    views.map((view) => [
      view,
      {
        closed: false,
        cleaned: false,
        ready: true,
        failure: null,
        deadline: Infinity,
      } satisfies WindowState,
    ]),
  );
  const displays = new Map(
    views.map((view) => [
      view,
      {
        visible: true,
        minimized: false,
      },
    ]),
  );
  const grants: Policy["backend"] = {
    permissions: [
      {
        identifier: "windows:control",
        allow: [
          ...views,
          "undeclared",
        ].map((view) => ({
          view,
        })),
        deny: [
          {
            view: "private",
          },
        ],
      },
    ],
  };
  const unused = (): never => {
    throw new Error("Unexpected native call");
  };
  function window(view: string): NativeWindow {
    const display = displays.get(view);
    if (!display) {
      throw new Error("Unknown test view");
    }
    return {
      showInactive() {
        if (failure) {
          throw failure;
        }
        calls.push(`showInactive:${view}`);
        display.visible = true;
      },
      activate() {
        if (failure) {
          throw failure;
        }
        calls.push(`activate:${view}`);
        if (acceptsActivation && display.visible && !display.minimized) {
          focused = view;
        }
        return focused === view;
      },
      isVisible: () => display.visible,
      isMinimized: () => display.minimized,
      isFocused: () => focused === view,
      focus: unused,
      show: unused,
      close: unused,
      getSnapshot: unused,
      minimize: unused,
      maximize: unused,
      unmaximize: unused,
      restore: unused,
      toggleMaximize: unused,
      isMaximized: unused,
      isFullscreen: unused,
      getBounds: unused,
      getDpi: unused,
      getSizeConstraints: unused,
      setSizeConstraints: unused,
      setSize: unused,
      setPosition: unused,
      setGeometry: unused,
      setFullscreen: unused,
      setCloseConfirmation: unused,
    };
  }
  const services: NativeWindowServices = {
    specs: views.map((view) => ({
      view,
      title: view,
      home: "https://app.bunaway.local",
      window: {
        width: 600,
        height: 400,
      },
    })),
    read: (view) => states.get(view),
    window,
    create: unused,
    close: unused,
    stopping: () => false,
    cancelled: () => false,
    now: Date.now,
    tick: async () => {},
  };
  const execute = createOperations({
    dataRoot: ".",
    capabilities: [],
    windows: services,
  }).executeUI;
  if (!execute) {
    throw new Error("Missing UI adapter");
  }
  return {
    calls,
    states,
    displays,
    grants,
    focus: (view: string) => {
      focused = view;
    },
    focused: () => focused,
    decline: () => {
      acceptsActivation = false;
    },
    fail: (error: Error) => {
      failure = error;
    },
    invoke: (name: (typeof names)[number], view = "main") =>
      Promise.resolve().then(() =>
        execute(
          `windows.${name}`,
          {
            view,
          },
          "main",
          {
            requestId: name,
            permissions: grants,
          },
        ),
      ),
  };
}

test("blur selects the first granted ready visible non-minimized app window and never an external target", async () => {
  const f = fixture();
  expect(await f.invoke("blur")).toBe(true);
  expect(f.focused()).toBe("editor");
  expect(f.calls).toEqual([
    "activate:editor",
  ]);
  expect(await f.invoke("blur")).toBe(true);
  expect(f.calls).toHaveLength(1);
  for (const excluded of [
    "hidden",
    "minimized",
    "closed",
    "not-ready",
    "failed",
  ] as const) {
    const next = fixture();
    const display = next.displays.get("editor");
    const state = next.states.get("editor");
    if (!display || !state) {
      throw new Error("Missing editor");
    }
    if (excluded === "hidden") {
      display.visible = false;
    }
    if (excluded === "minimized") {
      display.minimized = true;
    }
    if (excluded === "closed") {
      state.closed = true;
    }
    if (excluded === "not-ready") {
      state.ready = false;
    }
    if (excluded === "failed") {
      state.failure = new Error("Failed setup");
    }
    expect(await next.invoke("blur")).toBe(true);
    expect(next.focused()).toBe("reader");
    expect(next.calls).toEqual([
      "activate:reader",
    ]);
  }
  const noSuccessor = fixture();
  noSuccessor.grants.permissions = [
    {
      identifier: "windows:control",
      allow: [
        {
          view: "main",
        },
      ],
    },
  ];
  expect(await noSuccessor.invoke("blur")).toBe(false);
  expect(noSuccessor.calls).toEqual([]);
  const denied = fixture();
  denied.decline();
  expect(await denied.invoke("blur")).toBe(false);
  expect(denied.focused()).toBe("main");
  expect(denied.calls).toEqual([
    "activate:editor",
  ]);
});

test("activation rejection is a boolean and every new operation enforces source scope and open lifetime", async () => {
  const f = fixture();
  f.decline();
  expect(await f.invoke("activate", "editor")).toBe(false);
  expect(f.focused()).toBe("main");
  expect(await f.invoke("showInactive", "editor")).toBeNull();
  expect(f.focused()).toBe("main");
  for (const name of names) {
    const scoped = fixture();
    for (const view of [
      "private",
      "ungranted",
    ]) {
      await expect(scoped.invoke(name, view)).rejects.toMatchObject({
        code: "PERMISSION_DENIED",
      });
    }
    await expect(scoped.invoke(name, "undeclared")).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    const main = scoped.states.get("main");
    if (!main) {
      throw new Error("Missing main");
    }
    main.closed = true;
    await expect(scoped.invoke(name)).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    expect(scoped.calls).toEqual([]);
  }
  for (const name of names) {
    const failing = fixture();
    const failure = new Error("Native failure");
    failing.fail(failure);
    await expect(failing.invoke(name)).rejects.toBe(failure);
  }
});
