import { expect, test } from "bun:test";
import type {
  NativeWindow,
  NativeWindowServices,
} from "@bunaway/plugin-api/native";
import {
  MAX_DOWNLOAD_METADATA_BYTES,
  MAX_WEBVIEW_DOWNLOADS,
  type WebViewDownload,
} from "@bunaway/plugin-api/native";
import {
  validateWindowCall,
  validateWindowOutput,
  windowsPlugin,
} from "@bunaway/plugin-windows";
import { type JsonValue, NativeRegistry } from "@bunaway/protocol";
import { createOperations } from "#plugins/windows/src/platforms/windows";

const names = [
  "setDownloadRequestsEnabled",
  "getDownloads",
  "approveDownload",
  "cancelDownload",
  "pauseDownload",
  "resumeDownload",
  "forgetDownload",
] as const;
const id = crypto.randomUUID();
function fixture() {
  const actions: unknown[] = [];
  const unused = (): never => {
    throw new Error("Unrelated native control used");
  };
  const native: NativeWindow = {
    downloads: {
      setRequestsEnabled: (enabled) => {
        actions.push(enabled);
      },
      list: () => [],
      approve: (id) => {
        actions.push(id);
      },
      cancel: (id) => {
        actions.push(id);
      },
      pause: (id) => {
        actions.push(id);
      },
      resume: (id) => {
        actions.push(id);
      },
      forget: (id) => {
        actions.push(id);
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
        home: "https://app.bunaway.local/index.html",
        title: "main",
        window: {
          width: 800,
          height: 600,
        },
      },
    ],
    read: () => ({
      closed: false,
      cleaned: false,
      ready: true,
      failure: undefined,
      deadline: Infinity,
    }),
    create: unused,
    close: unused,
    window: () => native,
    stopping: () => false,
    cancelled: () => false,
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
  const invoke = (
    name: (typeof names)[number],
    source = "backend",
    payload: JsonValue = name === "setDownloadRequestsEnabled"
      ? {
          view: "main",
          enabled: true,
        }
      : name === "getDownloads"
        ? {
            view: "main",
          }
        : {
            view: "main",
            id,
          },
  ) => {
    if (!adapter.executeUI) {
      throw new Error("Missing UI adapter");
    }
    return adapter.executeUI(`windows.${name}`, payload, source, {
      requestId: "download-test",
      permissions,
    });
  };
  return {
    actions,
    native,
    permissions,
    invoke,
  };
}

test("download contracts register individual grants and forbid caller-selected paths", () => {
  const registry = new NativeRegistry([
    windowsPlugin,
  ]);
  for (const name of names) {
    expect(registry.operation(`windows.${name}`).name).toBe(`windows.${name}`);
  }
  expect(() =>
    validateWindowCall({
      operation: "windows.approveDownload",
      payload: {
        view: "main",
        id,
        path: "C:\\arbitrary.txt",
      },
    }),
  ).toThrow();
  expect(() =>
    validateWindowCall({
      operation: "windows.cancelDownload",
      payload: {
        view: "main",
        id: "not-a-lifetime-handle",
      },
    }),
  ).toThrow();
  expect(() =>
    validateWindowCall({
      operation: "windows.setDownloadRequestsEnabled",
      payload: {
        view: "main",
        enabled: 1,
      },
    }),
  ).toThrow();
  expect(validateWindowOutput("windows.getDownloads", [])).toEqual([]);
});

test("renderer-origin download calls are denied even when every operation is granted", async () => {
  const f = fixture();
  for (const name of names) {
    await expect(f.invoke(name, "view:main")).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
  }
  expect(f.actions).toEqual([]);
  f.permissions.permissions = [];
  for (const name of names) {
    await expect(f.invoke(name)).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
  }
  expect(f.actions).toEqual([]);
});

test("download output contracts reject oversized metadata and aggregate snapshots", () => {
  const record: WebViewDownload = {
    id,
    url: "https://app.bunaway.local/file.txt",
    mimeType: "text/plain",
    contentDisposition: "a".repeat(40 * 1024),
    path: "C:\\Downloads\\file.txt",
    totalBytes: null,
    receivedBytes: 0,
    state: "cancelled",
    interruptReason: null,
    canResume: false,
    paused: false,
  };
  expect(
    validateWindowOutput("windows.getDownloads", [
      record,
    ]),
  ).toEqual([
    record,
  ]);
  expect(() =>
    validateWindowOutput(
      "windows.getDownloads",
      Array.from(
        {
          length: MAX_WEBVIEW_DOWNLOADS,
        },
        () => ({
          ...record,
          id: crypto.randomUUID(),
        }),
      ),
    ),
  ).toThrow();
  expect(() =>
    validateWindowOutput("windows.getDownloads", [
      {
        ...record,
        contentDisposition: "\u0000".repeat(MAX_DOWNLOAD_METADATA_BYTES / 6),
      },
    ]),
  ).toThrow();
});

test("trusted backend dispatch and missing platform services preserve their contracts", async () => {
  const f = fixture();
  expect(await f.invoke("getDownloads")).toEqual([]);
  for (const name of names.filter((name) => name !== "getDownloads")) {
    expect(await f.invoke(name)).toBeNull();
  }
  expect(f.actions).toEqual([
    true,
    id,
    id,
    id,
    id,
    id,
  ]);
  delete f.native.downloads;
  await expect(f.invoke("getDownloads")).rejects.toMatchObject({
    code: "UNSUPPORTED",
  });
});
