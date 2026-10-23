import { expect, test } from "bun:test";
import type {
  NativeWindow,
  NativeWindowServices,
} from "@bunaway/plugin-api/native";
import windows, { validateWindowCall } from "@bunaway/plugin-windows";
import { type JsonValue, NativeRegistry } from "@bunaway/protocol";
import { createOperations } from "#plugins/windows/src/platforms/windows";

function fixture() {
  const actions: unknown[] = [];
  const unused = (): never => {
    throw new Error("Unrelated native control used");
  };
  const native: NativeWindow = {
    showPrintUI: (kind) => {
      actions.push(kind);
    },
    getSnapshot: unused,
    getReadiness: unused,
    show: unused,
    showInactive: unused,
    focus: unused,
    activate: unused,
    close: unused,
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

  let closed = false;
  let cancelled = false;
  const services: NativeWindowServices = {
    specs: [
      {
        view: "main",
        home: "https://app.bunaway.local/index.html",
        title: "main",
        window: {
          width: 800,
          height: 600,
        },
      },
    ],
    read: () => ({
      closed,
      cleaned: false,
      ready: true,
      failure: undefined,
      deadline: Infinity,
    }),
    create: unused,
    close: unused,
    window: () => native,
    stopping: () => false,
    cancelled: () => cancelled,
    now: Date.now,
    tick: async () => {},
  };
  const adapter = createOperations({
    dataRoot: ".",
    capabilities: [],
    windows: services,
  });
  const permissions = {
    permissions: [
      "windows.showPrintUI",
    ],
  };
  const invoke = (payload: JsonValue = {}) => {
    if (!adapter.executeUI) {
      throw new Error("Missing UI adapter");
    }
    return adapter.executeUI("windows.showPrintUI", payload, "backend", {
      requestId: "print-test",
      permissions,
    });
  };
  return {
    actions,
    native,
    permissions,
    invoke,
    close: () => {
      closed = true;
    },
    cancel: () => {
      cancelled = true;
    },
  };
}

test("print UI uses its own operation grant and strict browser/system contract", () => {
  const registry = new NativeRegistry([
    windows._definition,
  ]);
  expect(registry.operation("windows.showPrintUI").name).toBe(
    "windows.showPrintUI",
  );
  for (const payload of [
    {
      kind: "silent",
    },
    {
      printer: "PDF",
    },
    {
      path: "C:\\output.pdf",
    },
  ]) {
    expect(() =>
      validateWindowCall({
        operation: "windows.showPrintUI",
        payload,
      }),
    ).toThrow();
  }
});

test("print UI defaults to browser and dispatches system without claiming print completion", async () => {
  const f = fixture();
  expect(await f.invoke()).toBeNull();
  expect(
    await f.invoke({
      kind: "system",
    }),
  ).toBeNull();
  expect(f.actions).toEqual([
    "browser",
    "system",
  ]);
});

test("permission, cancellation, closed targets and missing services block print UI", async () => {
  const denied = fixture();
  denied.permissions.permissions = [];
  await expect(denied.invoke()).rejects.toMatchObject({
    code: "PERMISSION_DENIED",
  });
  expect(denied.actions).toEqual([]);
  const cancelled = fixture();
  cancelled.cancel();
  await expect(cancelled.invoke()).rejects.toMatchObject({
    code: "CANCELLED",
  });
  const closed = fixture();
  closed.close();
  await expect(closed.invoke()).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  });
  const unsupported = fixture();
  delete unsupported.native.showPrintUI;
  await expect(unsupported.invoke()).rejects.toMatchObject({
    code: "UNSUPPORTED",
  });
});
