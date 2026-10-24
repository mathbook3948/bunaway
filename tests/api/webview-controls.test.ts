import { expect, test } from "bun:test";
import type {
  NativeWindow,
  NativeWindowServices,
} from "@bunaway/plugin-api/native";
import windows, {
  validateWindowCall,
  validateWindowOutput,
} from "@bunaway/plugin-windows";
import type { JsonValue } from "@bunaway/protocol";
import { NativeRegistry } from "@bunaway/protocol";
import { createOperations } from "#plugins/windows/src/platforms/windows";

const names = [
  "getWebViewState",
  "navigateWebView",
  "reloadWebView",
  "stopWebView",
  "goBack",
  "goForward",
  "setZoomFactor",
  "openDevTools",
] as const;
const state = {
  url: "https://app.bunaway.local/",
  title: "Document",
  loading: false,
  canGoBack: true,
  canGoForward: false,
  zoomFactor: 1.25,
  focused: false,
};

/** Keep real authorization and instance dispatch, replacing only the native resource boundary. */
function fixture() {
  const actions: unknown[] = [];
  let closed = false;
  let cancelled = false;
  const unused = (): never => {
    throw new Error("Unrelated native control used");
  };
  const native: NativeWindow = {
    webview: {
      getState: () => ({
        ...state,
      }),
      navigate: (url) => {
        actions.push(url);
      },
      reload: (ignoreCache) => {
        actions.push(ignoreCache ? "reload-ignore-cache" : "reload");
      },
      stop: () => {
        actions.push("stop");
      },
      goBack: () => true,
      goForward: () => false,
      setZoomFactor: (factor) => {
        actions.push(factor);
        return factor;
      },
      openDevTools: () => {
        actions.push("devtools");
      },
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
  const services: NativeWindowServices = {
    specs: [
      {
        view: "main",
        home: state.url,
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
    permissions: names.map((name) => `windows.${name}`),
  };
  const invoke = (name: (typeof names)[number], payload: JsonValue = null) => {
    if (!adapter.executeUI) {
      throw new Error("Missing UI adapter");
    }
    return adapter.executeUI(`windows.${name}`, payload, "backend", {
      requestId: "test",
      permissions,
    });
  };
  return {
    native,
    actions,
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

test("WebView operations use strict Zod contracts and individual registered permissions", () => {
  const registry = new NativeRegistry([
    windows._definition,
  ]);
  for (const name of names) {
    expect(registry.operation(`windows.${name}`).name).toBe(`windows.${name}`);
  }
  expect(validateWindowOutput("windows.getWebViewState", state)).toEqual(state);
  expect(() =>
    validateWindowOutput("windows.getWebViewState", {
      ...state,
      zoomFactor: 0,
    }),
  ).toThrow();
  const { focused: _omitted, ...withoutFocused } = state;
  expect(() =>
    validateWindowOutput("windows.getWebViewState", withoutFocused),
  ).toThrow();
  for (const focused of [
    "true",
    1,
    null,
  ]) {
    expect(() =>
      validateWindowOutput("windows.getWebViewState", {
        ...state,
        focused,
      }),
    ).toThrow();
  }
  expect(
    validateWindowOutput("windows.getWebViewState", {
      ...state,
      focused: true,
    }),
  ).toEqual({
    ...state,
    focused: true,
  });
  for (const factor of [
    0.25,
    1,
    5,
  ]) {
    expect(
      validateWindowCall({
        operation: "windows.setZoomFactor",
        payload: {
          factor,
        },
      }).payload,
    ).toEqual({
      factor,
    });
  }
  for (const factor of [
    0,
    -1,
    0.249,
    5.001,
    "1",
    null,
  ]) {
    expect(() =>
      validateWindowCall({
        operation: "windows.setZoomFactor",
        payload: {
          factor,
        },
      }),
    ).toThrow();
  }
  for (const url of [
    "",
    "https://app.bunaway.local/\0",
    "x".repeat(8193),
  ]) {
    expect(() =>
      validateWindowCall({
        operation: "windows.navigateWebView",
        payload: {
          url,
        },
      }),
    ).toThrow();
  }
  for (const payload of [
    {},
    {
      ignoreCache: false,
    },
    {
      ignoreCache: true,
    },
  ]) {
    expect(
      validateWindowCall({
        operation: "windows.reloadWebView",
        payload,
      }),
    ).toBeDefined();
  }
  for (const payload of [
    {
      ignoreCache: "true",
    },
    {
      ignoreCache: 1,
    },
    {
      ignoreCache: true,
      extra: true,
    },
  ]) {
    expect(() =>
      validateWindowCall({
        operation: "windows.reloadWebView",
        payload,
      }),
    ).toThrow();
  }
});

test("WebView helpers dispatch queries, navigation and normalized zoom results", async () => {
  const f = fixture();
  expect(await f.invoke("getWebViewState")).toEqual(state);
  expect(await f.invoke("goBack")).toBe(true);
  expect(await f.invoke("goForward")).toBe(false);
  expect(
    await f.invoke("setZoomFactor", {
      factor: 1.5,
    }),
  ).toBe(1.5);
  await f.invoke("navigateWebView", {
    url: state.url,
  });
  await f.invoke("reloadWebView", {});
  await f.invoke("reloadWebView", {
    ignoreCache: false,
  });
  await f.invoke("reloadWebView", {
    ignoreCache: true,
  });
  await f.invoke("stopWebView");
  await f.invoke("openDevTools");
  expect(f.actions).toEqual([
    1.5,
    state.url,
    "reload",
    "reload",
    "reload-ignore-cache",
    "stop",
    "devtools",
  ]);
});

test("permission denial and cancelled or closed calls never enter native controls", async () => {
  const f = fixture();
  f.permissions.permissions = [
    "windows.getWebViewState",
  ];
  await expect(f.invoke("reloadWebView", {})).rejects.toMatchObject({
    code: "PERMISSION_DENIED",
  });
  expect(await f.invoke("getWebViewState")).toEqual(state);
  f.cancel();
  await expect(f.invoke("getWebViewState")).rejects.toMatchObject({
    code: "CANCELLED",
  });
  const closed = fixture();
  closed.close();
  await expect(closed.invoke("stopWebView")).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  });
  expect(f.actions).toEqual([]);
  expect(closed.actions).toEqual([]);
});

test("missing platform services and native failures are preserved", async () => {
  const f = fixture();
  delete f.native.webview;
  await expect(f.invoke("getWebViewState")).rejects.toMatchObject({
    code: "UNSUPPORTED",
  });
  const failed = fixture();
  const error = new Error("Browser failed");
  if (!failed.native.webview) {
    throw new Error("Missing test service");
  }
  failed.native.webview.reload = () => {
    throw error;
  };
  await expect(failed.invoke("reloadWebView", {})).rejects.toBe(error);
});
