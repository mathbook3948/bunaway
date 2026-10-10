import { expect, test } from "bun:test";
import type {
  NativeWindow,
  NativeWindowServices,
} from "@bunaway/plugin-api/native";
import type { Policy } from "@bunaway/protocol";
import { readWindowSpecs } from "@bunaway/runtime-bun/window-config";
import { createOperations } from "#plugins/windows/src/windows";

const policy: Policy = {
  version: 1,
  backend: {
    permissions: [],
  },
  views: [
    "main",
    "splash",
  ].map((id) => ({
    id,
    origins: [
      "https://app.bunaway.local",
    ],
    commands: [],
    events: [],
    host: {
      permissions: [],
    },
  })),
};
const specs = policy.views.map((view) => ({
  view: view.id,
  home: "https://app.bunaway.local/index.html",
  title: view.id,
  window: {
    width: 800,
    height: 600,
  },
}));

test("window configuration validates and preserves hidden and preparation display options", () => {
  expect(
    readWindowSpecs(
      [
        {
          ...specs[0],
          visible: false,
          showWhenReady: "sdk",
        },
      ],
      policy,
    )[0],
  ).toMatchObject({
    visible: false,
    showWhenReady: "sdk",
  });
  expect(
    readWindowSpecs(
      [
        {
          ...specs[0],
          showWhenReady: "document",
        },
      ],
      policy,
    )[0]?.showWhenReady,
  ).toBe("document");
  for (const input of [
    {
      visible: "false",
    },
    {
      showWhenReady: true,
    },
    {
      showWhenReady: "app",
    },
  ]) {
    expect(() =>
      readWindowSpecs(
        [
          {
            ...specs[0],
            ...input,
          },
        ],
        policy,
      ),
    ).toThrow();
  }
});

test("splashscreen handoff validates both targets and readiness before showing, then respects close refusal", async () => {
  const actions: string[] = [];
  let documentReady = false;
  let allowClose = false;
  let cancelled = false;
  let closed = false;
  const native: NativeWindow = {
    getReadiness: () => ({
      windowId: "window-main",
      viewId: "main",
      revision: 1,
      documentGeneration: 1,
      nativeCreated: true,
      document: documentReady ? "ready" : "pending",
      sdk: "ready",

      error: null,
    }),
    getSnapshot() {
      throw new Error("Unused display snapshot");
    },
    show(visible) {
      actions.push(`show:${visible}`);
    },
    focus: () => true,
    activate: () => true,
    showInactive() {},
    close: () => true,
    minimize() {},
    maximize() {},
    unmaximize() {},
    restore() {},
    toggleMaximize() {},
    isMinimized: () => false,
    isMaximized: () => false,
    isFullscreen: () => false,
    getBounds: () => ({
      x: 0,
      y: 0,
      width: 800,
      height: 600,
      dpi: 96,
    }),
    getDpi: () => 96,
    isVisible: () => false,
    isFocused: () => false,
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
  const services: NativeWindowServices = {
    specs,
    read: () => ({
      closed,
      cleaned: false,
      ready: true,
      failure: undefined,
      deadline: Date.now() + 30_000,
    }),
    create() {},
    close(view) {
      actions.push(`close:${view}`);
      return allowClose;
    },
    window: () => native,
    stopping: () => false,
    cancelled: () => cancelled,
    now: Date.now,
    tick: async () => {},
  };
  const adapter = createOperations({
    dataRoot: "",
    capabilities: [],
    windows: services,
  });
  const invoke = async (
    permissions: Policy["backend"],
    splash = "splash",
    operation = "windows.completeSplashscreen",
    source = "backend",
  ) =>
    adapter.executeUI?.(
      operation,
      {
        view: "main",
        ...(operation === "windows.completeSplashscreen"
          ? {
              splash,
            }
          : {}),
      },
      source,
      {
        requestId: "handoff",
        permissions,
      },
    );
  const mainOnly = {
    permissions: [
      {
        identifier: "windows:control",
        allow: [
          {
            view: "main",
          },
        ],
      },
    ],
  };
  const both = {
    permissions: [
      {
        identifier: "windows:control",
        allow: [
          {
            view: "main",
          },
          {
            view: "splash",
          },
        ],
      },
    ],
  };
  await expect(invoke(mainOnly)).rejects.toMatchObject({
    code: "PERMISSION_DENIED",
  });
  await expect(invoke(both)).rejects.toMatchObject({
    code: "BUSY",
  });
  expect(actions).toEqual([]);
  documentReady = true;
  await expect(invoke(both, "main")).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  });
  await expect(
    invoke(both, "splash", "windows.completeSplashscreen", "view:splash"),
  ).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  });
  expect(actions).toEqual([]);
  cancelled = true;
  await expect(invoke(both)).rejects.toMatchObject({
    code: "CANCELLED",
  });
  expect(actions).toEqual([]);
  cancelled = false;
  expect(await invoke(both)).toBe(false);
  expect(actions).toEqual([
    "show:true",
    "close:splash",
  ]);
  allowClose = true;
  expect(
    await invoke(both, "splash", "windows.completeSplashscreen", "view:main"),
  ).toBe(true);
  closed = true;
  expect(await invoke(both, "splash", "windows.getReadiness")).toMatchObject({
    sdk: "ready",
  });
});
