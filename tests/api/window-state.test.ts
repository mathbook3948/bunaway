import { expect, test } from "bun:test";
import type {
  NativeWindow,
  NativeWindowServices,
  WindowAttentionMode,
} from "@bunaway/plugin-api/native";
import windows, {
  validateWindowCall,
  validateWindowOutput,
  windowOperations,
} from "@bunaway/plugin-windows";
import { NativeRegistry, type Policy } from "@bunaway/protocol";
import { createOperations } from "#plugins/windows/src/platforms/windows";
import { windowPermissions } from "../fixtures/window-permissions.ts";

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
  windows._definition,
]);
const stateQueries = [
  ...queries,
  "isFocusable",
  "isAlwaysOnTop",
  "isSkipTaskbar",
  "isContentProtected",
  "isMinimizable",
  "isMaximizable",
  "isFullscreenable",
  "isClosable",
  "isResizable",
  "isMovable",
  "isNormal",
] as const;

test("window state schemas take no input and validate null or boolean outputs", () => {
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
        payload: null,
      }),
    ).toEqual({
      operation,
      payload: null,
    });
    for (const payload of [
      {},
      {
        view: "main",
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
  const attentionModes: WindowAttentionMode[] = [];
  let closed = false;
  let fullscreen = false;
  const fullscreenRequests: boolean[] = [];
  const observed = {
    isMinimized: false,
    isMaximized: false,
    isVisible: false,
    isFocused: false,
    isFocusable: true,
    isAlwaysOnTop: false,
    isSkipTaskbar: false,
    isContentProtected: false,
    isMinimizable: true,
    isMaximizable: true,
    isFullscreenable: true,
    isClosable: true,
    isResizable: true,
    isMovable: true,
  };
  let failure: Error | undefined;
  let title = "Declared title";
  let opacity = 1;
  let ignoreMouseEvents = false;
  let hasShadow = true;
  let backgroundColor: string | null = null;
  let accessibleTitle: string | null = null;
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
    getTitlebar: () => "custom",
    setAlwaysOnTop(value) {
      apply("setAlwaysOnTop");
      observed.isAlwaysOnTop = value;
    },
    isAlwaysOnTop: () => observed.isAlwaysOnTop,
    setSkipTaskbar(value) {
      apply("setSkipTaskbar");
      observed.isSkipTaskbar = value;
    },
    isSkipTaskbar: () => observed.isSkipTaskbar,
    setContentProtection(value) {
      apply("setContentProtection");
      observed.isContentProtected = value;
    },
    isContentProtected: () => observed.isContentProtected,
    requestAttention(mode) {
      apply("requestAttention");
      attentionModes.push(mode);
    },
    cancelAttention() {
      apply("cancelAttention");
    },
    setFocusable(value) {
      apply("setFocusable");
      observed.isFocusable = value;
    },
    isFocusable: () => observed.isFocusable,
    setMinimizable(value) {
      apply("setMinimizable");
      observed.isMinimizable = value;
    },
    isMinimizable: () => observed.isMinimizable,
    setMaximizable(value) {
      apply("setMaximizable");
      observed.isMaximizable = value;
    },
    isMaximizable: () => observed.isMaximizable,
    setClosable(value) {
      apply("setClosable");
      observed.isClosable = value;
    },
    isClosable: () => observed.isClosable,
    setTitle(value) {
      apply("setTitle");
      title = value;
    },
    getTitle: () => title,
    setOpacity(value) {
      apply("setOpacity");
      opacity = value;
    },
    getOpacity: () => opacity,
    setHasShadow(value) {
      apply("setHasShadow");
      hasShadow = value;
    },
    hasShadow: () => hasShadow,
    setBackgroundColor(value) {
      apply("setBackgroundColor");
      backgroundColor = value;
    },
    getBackgroundColor: () => backgroundColor,
    setIgnoreMouseEvents(value) {
      apply("setIgnoreMouseEvents");
      ignoreMouseEvents = value;
    },
    isIgnoreMouseEvents: () => ignoreMouseEvents,
    setAccessibleTitle(value) {
      apply("setAccessibleTitle");
      accessibleTitle = value === "" ? null : value;
    },
    getAccessibleTitle: () => accessibleTitle,
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
    setFullscreen(value) {
      fullscreenRequests.push(value);
      fullscreen = value;
    },
    setFullscreenable(value) {
      apply("setFullscreenable");
      observed.isFullscreenable = value;
    },
    isFullscreenable: () => observed.isFullscreenable,
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
    attentionModes,
    permissions,
    invoke: (
      name:
        | (typeof controls)[number]
        | (typeof stateQueries)[number]
        | "setFocusable"
        | "getTitlebar"
        | "setAlwaysOnTop"
        | "setSkipTaskbar"
        | "setContentProtection"
        | "requestAttention"
        | "cancelAttention"
        | "setMinimizable"
        | "setMaximizable"
        | "setFullscreenable"
        | "setFullscreen"
        | "setClosable"
        | "getTitle"
        | "setOpacity"
        | "getOpacity"
        | "setHasShadow"
        | "hasShadow"
        | "setBackgroundColor"
        | "getBackgroundColor"
        | "setIgnoreMouseEvents"
        | "isIgnoreMouseEvents"
        | "setTitle"
        | "setAccessibleTitle"
        | "getAccessibleTitle"
        | "setResizable"
        | "setMovable",
      payload: {
        focusable?: boolean;
        alwaysOnTop?: boolean;
        skipTaskbar?: boolean;
        contentProtection?: boolean;
        mode?: string | number | null;
        minimizable?: boolean;
        maximizable?: boolean;
        fullscreenable?: boolean;
        fullscreen?: boolean;
        closable?: boolean;
        title?: string;
        opacity?: number | string | null;
        ignore?: boolean;
        hasShadow?: boolean;
        color?: string | number | null;
        resizable?: boolean;
        movable?: boolean;
      } = {},
    ) =>
      Promise.resolve().then(() =>
        execute(
          `windows.${name}`,
          Object.keys(payload).length === 0 && name !== "requestAttention"
            ? null
            : {
                ...payload,
              },
          "backend",
          {
            requestId: name,
            permissions,
          },
        ),
      ),
    fullscreenRequests,
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
          ...payload,
        },
      }).operation,
    ).toBe("windows.setFocusable");
    expect(await f.invoke("setFocusable", payload)).toBeNull();
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
          ...payload,
        },
      }),
    ).toThrow();
  }
  f.permissions.permissions = [
    "windows.isFocusable",
  ];
  await expect(
    f.invoke("setFocusable", {
      focusable: true,
    }),
  ).rejects.toMatchObject({
    code: "PERMISSION_DENIED",
  });
  f.permissions.permissions = windowPermissions();
  f.setClosed();
  await expect(
    f.invoke("setFocusable", {
      focusable: true,
    }),
  ).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  });
  expect(f.actions).toHaveLength(3);
  const unsupported = fixture();
  delete unsupported.native.setFocusable;
  await expect(
    unsupported.invoke("setFocusable", {
      focusable: true,
    }),
  ).rejects.toMatchObject({
    code: "UNSUPPORTED",
  });
});

test("caption controls validate booleans, retain independent operation grants and reject closed targets", async () => {
  for (const [setter, getter, field] of [
    [
      "setMinimizable",
      "isMinimizable",
      "minimizable",
    ],
    [
      "setMaximizable",
      "isMaximizable",
      "maximizable",
    ],
    [
      "setFullscreenable",
      "isFullscreenable",
      "fullscreenable",
    ],
    [
      "setClosable",
      "isClosable",
      "closable",
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
            ...payload,
          },
        }).operation,
      ).toBe(`windows.${setter}`);
      expect(await f.invoke(setter, payload)).toBeNull();
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
      f.invoke(setter, {
        [field]: true,
      }),
    ).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
    f.permissions.permissions = windowPermissions();
    f.setClosed();
    await expect(
      f.invoke(setter, {
        [field]: true,
      }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    expect(f.actions).toHaveLength(3);
    const unsupported = fixture();
    delete unsupported.native[setter];
    await expect(
      unsupported.invoke(setter, {
        [field]: true,
      }),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
    const failed = fixture();
    failed.setFailure(new Error("Caption control failed"));
    await expect(
      failed.invoke(setter, {
        [field]: false,
      }),
    ).rejects.toThrow("Caption control failed");
    // These properties control user operations, independently of backend state APIs.
    const controlled = fixture();
    await controlled.invoke(setter, {
      [field]: false,
    });
    expect(await controlled.invoke("minimize")).toBeNull();
    expect(await controlled.invoke("maximize")).toBeNull();
  }
});

test("fullscreenable rejects entering fullscreen, keeps the current fullscreen and always allows leaving", async () => {
  const f = fixture();
  // Fullscreenable by default, so entering is forwarded to the native window.
  await f.invoke("setFullscreen", {
    fullscreen: true,
  });
  expect(f.fullscreenRequests).toEqual([
    true,
  ]);
  await f.invoke("setFullscreen", {
    fullscreen: false,
  });

  await f.invoke("setFullscreenable", {
    fullscreenable: false,
  });
  await expect(
    f.invoke("setFullscreen", {
      fullscreen: true,
    }),
  ).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
    message: expect.stringContaining("fullscreenable"),
  });
  expect(f.fullscreenRequests).toEqual([
    true,
    false,
  ]);

  // Re-enabling allows entering again.
  await f.invoke("setFullscreenable", {
    fullscreenable: true,
  });
  await f.invoke("setFullscreen", {
    fullscreen: true,
  });
  expect(await f.invoke("isFullscreen")).toBe(true);

  // Changing the setting while fullscreen keeps the state and still allows leaving.
  await f.invoke("setFullscreenable", {
    fullscreenable: false,
  });
  expect(await f.invoke("isFullscreen")).toBe(true);
  expect(await f.invoke("isFullscreenable")).toBe(false);
  await f.invoke("setFullscreen", {
    fullscreen: false,
  });
  expect(await f.invoke("isFullscreen")).toBe(false);
  await expect(
    f.invoke("setFullscreen", {
      fullscreen: true,
    }),
  ).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  });
  expect(f.fullscreenRequests).toEqual([
    true,
    false,
    true,
    false,
  ]);
});

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
          title,
        },
      }).payload,
    ).toEqual({
      title,
    });
    expect(
      await f.invoke("setTitle", {
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
          title,
        },
      }),
    ).toThrow();
  }
  expect(() =>
    validateWindowCall({
      operation: "windows.getTitle",
      payload: {
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
    f.invoke("setTitle", {
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
  f.setClosed();
  for (const operation of [
    "setTitle",
    "getTitle",
  ] as const) {
    await expect(
      f.invoke(
        operation,
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
    failed.invoke("setTitle", {
      title: "Failed",
    }),
  ).rejects.toThrow("Title change failed");
  expect(await failed.invoke("getTitle")).toBe("Declared title");
});

test("accessible titles are separate from captions, clear with an empty string and report unsupported windows", async () => {
  const f = fixture();
  expect(await f.invoke("getAccessibleTitle")).toBeNull();
  for (const title of [
    "읽기용 제목 📝",
    "x".repeat(1024),
  ]) {
    expect(
      validateWindowCall({
        operation: "windows.setAccessibleTitle",
        payload: {
          title,
        },
      }).payload,
    ).toEqual({
      title,
    });
    expect(
      await f.invoke("setAccessibleTitle", {
        title,
      }),
    ).toBeNull();
    expect(await f.invoke("getAccessibleTitle")).toBe(title);
  }
  // The caption is untouched by accessible title changes, and the reverse also holds.
  expect(await f.invoke("getTitle")).toBe("Declared title");
  await f.invoke("setTitle", {
    title: "Caption only",
  });
  expect(await f.invoke("getAccessibleTitle")).toBe("x".repeat(1024));
  expect(
    await f.invoke("setAccessibleTitle", {
      title: "",
    }),
  ).toBeNull();
  expect(await f.invoke("getAccessibleTitle")).toBeNull();
  expect(await f.invoke("getTitle")).toBe("Caption only");
  for (const title of [
    "bad\0title",
    "x".repeat(1025),
    "📝".repeat(513),
    42,
    null,
  ]) {
    expect(() =>
      validateWindowCall({
        operation: "windows.setAccessibleTitle",
        payload: {
          title,
        },
      }),
    ).toThrow();
  }
  expect(validateWindowOutput("windows.getAccessibleTitle", "읽기용")).toBe(
    "읽기용",
  );
  expect(validateWindowOutput("windows.getAccessibleTitle", null)).toBeNull();
  expect(() =>
    validateWindowOutput("windows.getAccessibleTitle", "x".repeat(1025)),
  ).toThrow();
  expect(validateWindowOutput("windows.setAccessibleTitle", null)).toBeNull();
  f.permissions.permissions = [
    "windows.getAccessibleTitle",
  ];
  await expect(
    f.invoke("setAccessibleTitle", {
      title: "Denied",
    }),
  ).rejects.toMatchObject({
    code: "PERMISSION_DENIED",
  });
  f.permissions.permissions = [
    "windows.setAccessibleTitle",
  ];
  await expect(f.invoke("getAccessibleTitle")).rejects.toMatchObject({
    code: "PERMISSION_DENIED",
  });
  for (const operation of [
    "setAccessibleTitle",
    "getAccessibleTitle",
  ] as const) {
    const unsupported = fixture();
    delete unsupported.native[operation];
    await expect(
      unsupported.invoke(
        operation,
        operation === "setAccessibleTitle"
          ? {
              title: "Unsupported",
            }
          : {},
      ),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
  }
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
            ...payload,
          },
        }).operation,
      ).toBe(`windows.${setter}`);
      expect(await f.invoke(setter, payload)).toBeNull();
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
      f.invoke(setter, {
        [field]: true,
      }),
    ).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
    f.permissions.permissions = windowPermissions();
    f.setClosed();
    await expect(
      f.invoke(setter, {
        [field]: true,
      }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    expect(f.actions).toHaveLength(3);
    const unsupported = fixture();
    delete unsupported.native[setter];
    await expect(
      unsupported.invoke(setter, {
        [field]: true,
      }),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
    const failed = fixture();
    failed.setFailure(new Error("Movement failed"));
    await expect(
      failed.invoke(setter, {
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
    expect(
      registry.allowed(
        {
          permissions: [],
        },
        {
          operation: `windows.${name}`,
          payload: null,
        },
      ),
    ).toBe(false);
    await expect(f.invoke(name)).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
    f.permissions.permissions = windowPermissions();
    f.setClosed();
    if (name === "isFocused") {
      expect(await f.invoke(name)).toBe(false);
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
  await expect(f.invoke("isNormal")).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  });
  expect(f.actions).toEqual([]);
});

test("display controls retain independent permissions, strict input and closed/unsupported guards", async () => {
  for (const [setter, getter, field] of [
    [
      "setAlwaysOnTop",
      "isAlwaysOnTop",
      "alwaysOnTop",
    ],
    [
      "setSkipTaskbar",
      "isSkipTaskbar",
      "skipTaskbar",
    ],
    [
      "setContentProtection",
      "isContentProtected",
      "contentProtection",
    ],
  ] as const) {
    const f = fixture();
    expect(await f.invoke(getter)).toBe(false);
    for (const value of [
      true,
      false,
    ]) {
      expect(
        await f.invoke(setter, {
          [field]: value,
        }),
      ).toBeNull();
      expect(await f.invoke(getter)).toBe(value);
    }
    for (const value of [
      null,
      1,
      "true",
    ]) {
      expect(() =>
        validateWindowCall({
          operation: `windows.${setter}`,
          payload: {
            [field]: value,
          },
        }),
      ).toThrow();
    }
    f.permissions.permissions = [
      `windows.${getter}`,
    ];
    await expect(
      f.invoke(setter, {
        [field]: true,
      }),
    ).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
    expect(f.actions).toHaveLength(2);
    f.permissions.permissions = windowPermissions();
    f.setClosed();
    await expect(
      f.invoke(setter, {
        [field]: true,
      }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    const unsupported = fixture();
    delete unsupported.native[setter];
    await expect(
      unsupported.invoke(setter, {
        [field]: true,
      }),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
  }
  const f = fixture();
  expect(await f.invoke("getTitlebar")).toBe("custom");
  expect(() =>
    validateWindowOutput("windows.getTitlebar", "frameless"),
  ).toThrow();
  f.permissions.permissions = [];
  await expect(f.invoke("getTitlebar")).rejects.toMatchObject({
    code: "PERMISSION_DENIED",
  });
});

test("macOS target declares the content protection operations its adapter implements", () => {
  // The host rejects any operation missing from the target list as UNSUPPORTED before the
  // shared adapter runs, so a generic adapter test alone cannot catch a missing declaration.
  expect(windows._definition.nativePlatforms.macos?.operations).toEqual(
    expect.arrayContaining([
      "setContentProtection",
      "isContentProtected",
    ]),
  );
});

test("attention requests resolve the default mode, validate input and stay separate from focus", async () => {
  const f = fixture();
  expect(await f.invoke("requestAttention")).toBeNull();
  expect(
    await f.invoke("requestAttention", {
      mode: "continuous",
    }),
  ).toBeNull();
  expect(f.attentionModes).toEqual([
    "untilFocused",
    "continuous",
  ]);
  expect(await f.invoke("cancelAttention")).toBeNull();
  expect(f.actions).toEqual([
    "requestAttention",
    "requestAttention",
    "cancelAttention",
  ]);
  expect(await f.invoke("isFocused")).toBe(false);
  for (const mode of [
    null,
    1,
    "always",
    "",
  ]) {
    expect(() =>
      validateWindowCall({
        operation: "windows.requestAttention",
        payload: {
          mode,
        },
      }),
    ).toThrow();
    await expect(
      f.invoke("requestAttention", {
        mode,
      }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  }
  expect(() =>
    validateWindowCall({
      operation: "windows.cancelAttention",
      payload: {
        mode: "continuous",
      },
    }),
  ).toThrow();
  expect(f.attentionModes).toHaveLength(2);
  for (const name of [
    "requestAttention",
    "cancelAttention",
  ] as const) {
    f.permissions.permissions = [];
    await expect(f.invoke(name)).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
    f.permissions.permissions = windowPermissions();
    const unsupported = fixture();
    delete unsupported.native[name];
    await expect(unsupported.invoke(name)).rejects.toMatchObject({
      code: "UNSUPPORTED",
      message:
        "Window attention requests are not implemented on this platform.",
    });
  }
  f.setClosed();
  await expect(f.invoke("cancelAttention")).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  });
});

test("opacity accepts only numbers from 0 to 1, round-trips and keeps its own permission grants", async () => {
  const f = fixture();
  expect(await f.invoke("getOpacity")).toBe(1);
  for (const opacity of [
    0,
    0.25,
    1,
  ]) {
    expect(
      await f.invoke("setOpacity", {
        opacity,
      }),
    ).toBeNull();
    expect(await f.invoke("getOpacity")).toBe(opacity);
  }
  for (const payload of [
    {},
    {
      opacity: -0.1,
    },
    {
      opacity: 1.1,
    },
    {
      opacity: "0.5",
    },
    {
      opacity: null,
    },
    {
      opacity: 0.5,
      extra: true,
    },
  ]) {
    expect(() =>
      validateWindowCall({
        operation: "windows.setOpacity",
        payload: {
          ...payload,
        },
      }),
    ).toThrow();
  }
  expect(validateWindowOutput("windows.getOpacity", 0.5)).toBe(0.5);
  for (const output of [
    -0.1,
    1.1,
    "1",
    null,
  ]) {
    expect(() => validateWindowOutput("windows.getOpacity", output)).toThrow();
  }
  f.permissions.permissions = [];
  await expect(f.invoke("getOpacity")).rejects.toMatchObject({
    code: "PERMISSION_DENIED",
  });
  f.permissions.permissions = windowPermissions();
  f.setClosed();
  await expect(f.invoke("getOpacity")).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  });
});

test("macOS target does not declare the Windows-only opacity operations", () => {
  expect(windows._definition.nativePlatforms.macos?.operations).not.toEqual(
    expect.arrayContaining([
      "setOpacity",
    ]),
  );
  expect(windows._definition.nativePlatforms.windows?.operations).toEqual(
    expect.arrayContaining([
      "setOpacity",
      "getOpacity",
    ]),
  );
});

test("window shadow takes only a boolean, round-trips from the default and keeps its own permission grants", async () => {
  const f = fixture();
  expect(await f.invoke("hasShadow")).toBe(true);
  for (const hasShadow of [
    false,
    true,
  ]) {
    expect(
      await f.invoke("setHasShadow", {
        hasShadow,
      }),
    ).toBeNull();
    expect(await f.invoke("hasShadow")).toBe(hasShadow);
  }
  for (const payload of [
    {},
    {
      hasShadow: "false",
    },
    {
      hasShadow: 0,
    },
    {
      hasShadow: null,
    },
    {
      hasShadow: true,
      elevation: 1,
    },
  ]) {
    expect(() =>
      validateWindowCall({
        operation: "windows.setHasShadow",
        payload: {
          ...payload,
        },
      }),
    ).toThrow();
  }
  expect(validateWindowOutput("windows.hasShadow", true)).toBe(true);
  expect(() => validateWindowOutput("windows.hasShadow", 1)).toThrow();
  f.permissions.permissions = [];
  await expect(f.invoke("hasShadow")).rejects.toMatchObject({
    code: "PERMISSION_DENIED",
  });
  f.permissions.permissions = windowPermissions();
  f.setClosed();
  await expect(f.invoke("hasShadow")).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  });
});

test("window background color normalizes valid colors, rejects alpha and other forms, and keeps its own permission grants", async () => {
  const f = fixture();
  expect(await f.invoke("getBackgroundColor")).toBeNull();
  for (const [color, expected] of [
    [
      "#203040",
      "#203040",
    ],
    [
      "#ABC",
      "#aabbcc",
    ],
    [
      "#A0b0C0",
      "#a0b0c0",
    ],
  ] as const) {
    expect(
      await f.invoke("setBackgroundColor", {
        color,
      }),
    ).toBeNull();
    expect(await f.invoke("getBackgroundColor")).toBe(expected);
  }
  for (const color of [
    "#11223344",
    "#1234",
    "112233",
    "#12345g",
    "red",
    "rgb(1,2,3)",
    " #112233",
    "#112233\n",
    "",
    1,
    null,
  ]) {
    expect(() =>
      validateWindowCall({
        operation: "windows.setBackgroundColor",
        payload: {
          color,
        },
      }),
    ).toThrow();
  }
  expect(() =>
    validateWindowCall({
      operation: "windows.setBackgroundColor",
      payload: {
        color: "#112233",
        alpha: 1,
      },
    }),
  ).toThrow();
  expect(validateWindowOutput("windows.getBackgroundColor", null)).toBeNull();
  expect(validateWindowOutput("windows.getBackgroundColor", "#112233")).toBe(
    "#112233",
  );
  expect(() => validateWindowOutput("windows.getBackgroundColor", 1)).toThrow();
  f.permissions.permissions = [];
  await expect(f.invoke("getBackgroundColor")).rejects.toMatchObject({
    code: "PERMISSION_DENIED",
  });
  f.permissions.permissions = windowPermissions();
  f.setClosed();
  await expect(f.invoke("getBackgroundColor")).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  });
});

test("macOS target does not declare the Windows-only background color operations", () => {
  expect(windows._definition.nativePlatforms.macos?.operations).not.toEqual(
    expect.arrayContaining([
      "setBackgroundColor",
    ]),
  );
  expect(windows._definition.nativePlatforms.windows?.operations).toEqual(
    expect.arrayContaining([
      "setBackgroundColor",
      "getBackgroundColor",
    ]),
  );
});

test("macOS target does not declare the Windows-only shadow operations", () => {
  expect(windows._definition.nativePlatforms.macos?.operations).not.toEqual(
    expect.arrayContaining([
      "setHasShadow",
    ]),
  );
  expect(windows._definition.nativePlatforms.windows?.operations).toEqual(
    expect.arrayContaining([
      "setHasShadow",
      "hasShadow",
    ]),
  );
});

test("ignoring mouse events takes only a boolean, round-trips and keeps its own permission grants", async () => {
  const f = fixture();
  expect(await f.invoke("isIgnoreMouseEvents")).toBe(false);
  for (const ignore of [
    true,
    false,
  ]) {
    expect(
      await f.invoke("setIgnoreMouseEvents", {
        ignore,
      }),
    ).toBeNull();
    expect(await f.invoke("isIgnoreMouseEvents")).toBe(ignore);
  }
  for (const payload of [
    {},
    {
      ignore: "true",
    },
    {
      ignore: 1,
    },
    {
      ignore: null,
    },
    {
      ignore: true,
      forward: true,
    },
  ]) {
    expect(() =>
      validateWindowCall({
        operation: "windows.setIgnoreMouseEvents",
        payload: {
          ...payload,
        },
      }),
    ).toThrow();
  }
  expect(validateWindowOutput("windows.isIgnoreMouseEvents", true)).toBe(true);
  expect(() =>
    validateWindowOutput("windows.isIgnoreMouseEvents", 1),
  ).toThrow();
  f.permissions.permissions = [];
  await expect(f.invoke("isIgnoreMouseEvents")).rejects.toMatchObject({
    code: "PERMISSION_DENIED",
  });
  f.permissions.permissions = windowPermissions();
  f.setClosed();
  await expect(f.invoke("isIgnoreMouseEvents")).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  });
});

test("macOS target does not declare the Windows-only mouse-event operations", () => {
  expect(windows._definition.nativePlatforms.macos?.operations).not.toEqual(
    expect.arrayContaining([
      "setIgnoreMouseEvents",
    ]),
  );
  expect(windows._definition.nativePlatforms.windows?.operations).toEqual(
    expect.arrayContaining([
      "setIgnoreMouseEvents",
      "isIgnoreMouseEvents",
    ]),
  );
});
