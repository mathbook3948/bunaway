import { expect, test } from "bun:test";
import type {
  NativeWindow,
  NativeWindowServices,
  WindowState,
} from "@bunaway/plugin-api/native";
import windows, {
  validateWindowCall,
  validateWindowOutput,
} from "@bunaway/plugin-windows";
import { NativeRegistry, type Policy } from "@bunaway/protocol";
import { createOperations } from "#plugins/windows/src/platforms/windows";
import { windowPermissions } from "../fixtures/window-permissions.ts";

const names = [
  "showInactive",
  "activate",
] as const;

test("inactive display and activation contracts take no input and validate their actual results", () => {
  const registry = new NativeRegistry([
    windows._definition,
  ]);
  for (const name of names) {
    const operation = `windows.${name}` as const;
    expect(registry.operation(operation).name).toBe(operation);
    expect(
      validateWindowCall({
        operation,
        payload: null,
      }).payload,
    ).toBeNull();
    for (const payload of [
      {},
      {
        view: "main",
      },
      {
        windowId: "main",
      },
      {
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
  const calls: string[] = [];
  let focused = false;
  let acceptsActivation = true;
  let failure: Error | undefined;
  const state: WindowState = {
    closed: false,
    cleaned: false,
    ready: true,
    failure: null,
    deadline: Infinity,
  };
  const display = {
    visible: false,
    minimized: false,
  };
  const grants: Policy["backend"] = {
    permissions: [
      ...windowPermissions(),
    ],
  };
  const unused = (): never => {
    throw new Error("Unexpected native call");
  };
  const native: NativeWindow = {
    showInactive() {
      if (failure) {
        throw failure;
      }
      calls.push("showInactive");
      display.visible = true;
    },
    activate() {
      if (failure) {
        throw failure;
      }
      calls.push("activate");
      if (acceptsActivation && display.visible && !display.minimized) {
        focused = true;
      }
      return focused;
    },
    isVisible: () => display.visible,
    isMinimized: () => display.minimized,
    isFocusable: () => true,
    isFocused: () => focused,
    focus: unused,
    show: unused,
    close: unused,
    getSnapshot: unused,
    getReadiness: unused,
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
  const services: NativeWindowServices = {
    specs: [
      {
        view: "main",
        title: "main",
        home: "https://app.bunaway.local",
        window: {
          width: 600,
          height: 400,
        },
      },
    ],
    read: (view) => (view === "main" ? state : undefined),
    window: () => native,
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
    state,
    display,
    grants,
    decline: () => {
      acceptsActivation = false;
    },
    fail: (error: Error) => {
      failure = error;
    },
    focused: () => focused,
    invoke: (name: (typeof names)[number]) =>
      Promise.resolve().then(() =>
        execute(`windows.${name}`, null, "main", {
          requestId: name,
          permissions: grants,
        }),
      ),
  };
}

test("showInactive shows without activating and activate follows the OS decision", async () => {
  const f = fixture();
  expect(await f.invoke("showInactive")).toBeNull();
  expect(f.focused()).toBe(false);
  expect(await f.invoke("activate")).toBe(true);
  expect(f.calls).toEqual([
    "showInactive",
    "activate",
  ]);
  const declined = fixture();
  declined.decline();
  declined.display.visible = true;
  expect(await declined.invoke("activate")).toBe(false);
  expect(declined.focused()).toBe(false);
});

test("every operation enforces source grants and an open window", async () => {
  for (const name of names) {
    const scoped = fixture();
    scoped.grants.permissions = [];
    await expect(scoped.invoke(name)).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
    scoped.grants.permissions = windowPermissions();
    scoped.state.closed = true;
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
