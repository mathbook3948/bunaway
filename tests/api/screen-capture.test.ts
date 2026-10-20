import { expect, test } from "bun:test";
import screenCapture from "@bunaway/plugin-screen-capture";
import { BunawayError, NativeRegistry } from "@bunaway/protocol";
import {
  captureInputSchema,
  captureOutputSchema,
  DEFAULT_CAPTURE_EDGE_PIXELS,
  listSourcesInputSchema,
  MAX_CAPTURE_PNG_BYTES,
  MAX_SOURCE_NAME_CHARS,
  MAX_SOURCES,
  type ScreenCaptureListInput,
  sourceListSchema,
} from "#plugins/screen-capture/src/contract";
import { screenCaptureOperations } from "#plugins/screen-capture/src/operations";
import { encodePng } from "#plugins/screen-capture/src/platforms/png";
import {
  type CaptureBindings,
  fitSize,
  type MonitorFacts,
  type Rect,
  truncateName,
  type WindowFacts,
  WindowsScreenCapture,
} from "#plugins/screen-capture/src/platforms/windows-capture";
import { decodePng } from "../fixtures/png.ts";

const APP_PID = 4242;
const SHELL = 99n;
const PREVIOUS_DPI = -2n;

/** A visible, ordinary window of another process; tests override single fields. */
function windowFacts(overrides: Partial<WindowFacts> = {}): WindowFacts {
  const rect: Rect = {
    x: 100,
    y: 50,
    width: 800,
    height: 600,
  };
  return {
    title: "Notes",
    visible: true,
    minimized: false,
    cloaked: false,
    hasOwner: false,
    toolWindow: false,
    displayAffinity: 0,
    hung: false,
    pid: 7,
    tid: 70,
    windowRect: rect,
    frameRect: {
      x: 108,
      y: 50,
      width: 784,
      height: 592,
    },
    ...overrides,
  };
}

interface FakeWorld {
  windows: Map<bigint, WindowFacts>;
  monitors: MonitorFacts[];
  /** Name of a native call that should fail once; compared with the call log entry. */
  failOn?: string;
  /** Paint copied pixels with noise instead of one color, so the PNG cannot compress. */
  noise?: boolean;
  log: string[];
}

/**
 * Bindings backed by an in-memory world. Every GDI handle is tracked so tests can tell which
 * objects are still alive, and every blit paints the target bitmap with one color.
 */
function fakeBindings(world: FakeWorld) {
  let next = 1000n;
  const alive = new Set<bigint>();
  const bitmaps = new Map<bigint, Uint8Array>();
  const selected = new Map<bigint, bigint>();
  const step = (name: string) => {
    world.log.push(name);
    if (world.failOn === name) {
      delete world.failOn;
      return false;
    }
    return true;
  };
  const make = (name: string) => {
    if (!step(name)) {
      return 0n;
    }
    next += 1n;
    alive.add(next);
    return next;
  };
  const drop = (name: string, handle: bigint) => {
    const ok = step(name) && alive.delete(handle);
    return ok;
  };
  const bindings: CaptureBindings = {
    setDpiAwareness: () => (step("setDpi") ? PREVIOUS_DPI : 0n),
    restoreDpiAwareness: (previous) => {
      expect(previous).toBe(PREVIOUS_DPI);
      return step("restoreDpi");
    },
    listWindows: () => [
      ...world.windows.keys(),
    ],
    shellWindow: () => SHELL,
    windowFacts: (window) => world.windows.get(window) ?? null,
    listMonitors: () => world.monitors,
    getScreenDc: () => make("GetDC"),
    releaseScreenDc: (dc) => drop("ReleaseDC", dc),
    createMemoryDc: () => make("CreateCompatibleDC"),
    deleteDc: (dc) => drop("DeleteDC", dc),
    createDib(_compatible, width, height) {
      const bitmap = make("CreateDIBSection");
      if (bitmap === 0n) {
        return null;
      }
      const pixels = new Uint8Array(width * height * 4);
      bitmaps.set(bitmap, pixels);
      return {
        bitmap,
        pixels,
      };
    },
    selectObject(dc, object) {
      world.log.push("SelectObject");
      const previous = selected.get(dc) ?? 5n;
      selected.set(dc, object);
      return world.failOn === "SelectObject" ? 0n : previous;
    },
    deleteObject: (object) => drop("DeleteObject", object),
    flush: () => world.log.push("GdiFlush"),
    printWindow: () => step("PrintWindow"),
    blit(target, targetSize, _source, _sourceRect, fromScreen) {
      if (!step(fromScreen ? "BlitScreen" : "BlitWindow")) {
        return false;
      }
      const pixels = bitmaps.get(selected.get(target) ?? 0n);
      if (!pixels) {
        return false;
      }
      let seed = 7;
      for (let at = 0; at < targetSize.width * targetSize.height; at += 1) {
        seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
        pixels.set(
          world.noise
            ? [
                seed >> 16,
                seed >> 8,
                seed,
                0,
              ]
            : [
                10,
                20,
                30,
                0,
              ],
          at * 4,
        );
      }
      return true;
    },
  };
  return {
    bindings,
    alive,
  };
}

function setup(
  windows: Array<
    [
      bigint,
      WindowFacts,
    ]
  > = [],
  monitors: MonitorFacts[] = [],
) {
  const world: FakeWorld = {
    windows: new Map(windows),
    monitors,
    log: [],
  };
  const fake = fakeBindings(world);
  let released = 0;
  const adapter = new WindowsScreenCapture(fake.bindings, APP_PID, () => {
    released += 1;
  });
  return {
    world,
    adapter,
    alive: fake.alive,
    released: () => released,
  };
}

const primary: MonitorFacts = {
  deviceName: "\\\\.\\DISPLAY1",
  bounds: {
    x: 0,
    y: 0,
    width: 1920,
    height: 1080,
  },
};

function errorOf(action: () => unknown): BunawayError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(BunawayError);
    return error as BunawayError;
  }
  throw new Error("Expected the call to fail.");
}

test("inputs are strict, typed and bounded", () => {
  expect(
    listSourcesInputSchema.safeParse({
      types: [
        "screen",
        "window",
      ],
    }).success,
  ).toBe(true);
  for (const bad of [
    {},
    {
      types: [],
    },
    {
      types: [
        "screen",
        "screen",
      ],
    },
    {
      types: [
        "tab",
      ],
    },
    {
      types: [
        "screen",
      ],
      extra: 1,
    },
    null,
  ]) {
    expect(listSourcesInputSchema.safeParse(bad).success).toBe(false);
  }
  const id = crypto.randomUUID();
  expect(
    captureInputSchema.safeParse({
      id,
    }).success,
  ).toBe(true);
  expect(
    captureInputSchema.safeParse({
      id,
      maxWidth: 1,
      maxHeight: 4096,
    }).success,
  ).toBe(true);
  for (const bad of [
    {
      id: "7",
    },
    {
      id,
      maxWidth: 0,
    },
    {
      id,
      maxHeight: 4097,
    },
    {
      id,
      maxWidth: 1.5,
    },
    {
      id,
      extra: true,
    },
  ]) {
    expect(captureInputSchema.safeParse(bad).success).toBe(false);
  }
  expect(
    captureOutputSchema.safeParse({
      mime: "image/jpeg",
      data: "",
      width: 1,
      height: 1,
    }).success,
  ).toBe(false);
});

test("each operation has its own permission", () => {
  const registry = new NativeRegistry([
    screenCapture._definition,
  ]);
  expect([
    ...registry.operations.keys(),
  ]).toEqual([
    "screenCapture.listSources",
    "screenCapture.captureSource",
  ]);
  const id = crypto.randomUUID();
  const allowed = (permission: string, operation: string, payload: object) =>
    registry.allowed(
      {
        permissions: [
          permission,
        ],
      },
      {
        operation,
        payload: payload as never,
      },
    );
  const list = {
    types: [
      "screen",
    ],
  };
  expect(
    allowed("screenCapture.listSources", "screenCapture.listSources", list),
  ).toBe(true);
  expect(
    allowed("screenCapture.captureSource", "screenCapture.listSources", list),
  ).toBe(false);
  expect(
    allowed("screenCapture.captureSource", "screenCapture.captureSource", {
      id,
    }),
  ).toBe(true);
  expect(
    allowed("screenCapture.listSources", "screenCapture.captureSource", {
      id,
    }),
  ).toBe(false);
  expect(Object.keys(screenCaptureOperations)).toEqual([
    "listSources",
    "captureSource",
  ]);
});

test("a listing keeps ordinary visible windows and numbers the monitors", () => {
  const { adapter } = setup(
    [
      [
        1n,
        windowFacts(),
      ],
      [
        2n,
        windowFacts({
          title: "Hidden",
          visible: false,
        }),
      ],
      [
        3n,
        windowFacts({
          title: "",
        }),
      ],
      [
        4n,
        windowFacts({
          title: "Owned dialog",
          hasOwner: true,
        }),
      ],
      [
        5n,
        windowFacts({
          title: "Tool",
          toolWindow: true,
        }),
      ],
      [
        6n,
        windowFacts({
          title: "Other desktop",
          cloaked: true,
        }),
      ],
      [
        SHELL,
        windowFacts({
          title: "Program Manager",
        }),
      ],
      [
        7n,
        windowFacts({
          title: "Mine",
          pid: APP_PID,
          minimized: true,
        }),
      ],
    ],
    [
      primary,
      {
        deviceName: "\\\\.\\DISPLAY2",
        bounds: {
          x: -1280,
          y: 0,
          width: 1280,
          height: 1024,
        },
      },
    ],
  );
  const sources = adapter.listSources({
    types: [
      "screen",
      "window",
    ],
  });
  expect(sourceListSchema.safeParse(sources).success).toBe(true);
  expect(
    sources.map((source) => [
      source.kind,
      source.name,
      source.ownedByApp,
      source.minimized,
      source.monitorId,
    ]),
  ).toEqual([
    [
      "screen",
      "Screen 1",
      false,
      false,
      "\\\\.\\DISPLAY1",
    ],
    [
      "screen",
      "Screen 2",
      false,
      false,
      "\\\\.\\DISPLAY2",
    ],
    [
      "window",
      "Notes",
      false,
      false,
      undefined,
    ],
    [
      "window",
      "Mine",
      true,
      true,
      undefined,
    ],
  ]);
  expect(sources[1]?.bounds).toEqual({
    x: -1280,
    y: 0,
    width: 1280,
    height: 1024,
  });
  // Window bounds are the visible frame, not the rectangle with the resize border.
  expect(sources[2]?.bounds).toEqual({
    x: 108,
    y: 50,
    width: 784,
    height: 592,
  });
  expect(new Set(sources.map((source) => source.id)).size).toBe(4);
});

test("source ids are stable while a source stays and are dropped when it leaves", () => {
  const { adapter, world } = setup(
    [
      [
        1n,
        windowFacts(),
      ],
    ],
    [
      primary,
    ],
  );
  const both: ScreenCaptureListInput = {
    types: [
      "screen",
      "window",
    ],
  };
  const first = adapter.listSources(both);
  expect(adapter.listSources(both).map((source) => source.id)).toEqual(
    first.map((source) => source.id),
  );
  world.windows.delete(1n);
  adapter.listSources({
    types: [
      "window",
    ],
  });
  const windowId = first[1]?.id as string;
  const screenId = first[0]?.id as string;
  const gone = errorOf(() =>
    adapter.captureSource({
      id: windowId,
    }),
  );
  expect([
    gone.code,
    gone.details,
  ]).toEqual([
    "INVALID_ARGUMENT",
    {
      reason: "SOURCE_NOT_FOUND",
    },
  ]);
  // A window-only listing leaves the monitor ids alone.
  expect(
    adapter.captureSource({
      id: screenId,
    }).mime,
  ).toBe("image/png");
  // A recycled window handle with another thread is a different source.
  world.windows.set(
    1n,
    windowFacts({
      tid: 71,
    }),
  );
  const [reused] = adapter.listSources({
    types: [
      "window",
    ],
  });
  expect(reused?.id).not.toBe(windowId);
});

test("a window whose thread changed since the listing is not captured", () => {
  const { adapter, world } = setup([
    [
      1n,
      windowFacts(),
    ],
  ]);
  const [source] = adapter.listSources({
    types: [
      "window",
    ],
  });
  world.windows.set(
    1n,
    windowFacts({
      pid: 8,
    }),
  );
  const error = errorOf(() =>
    adapter.captureSource({
      id: source?.id as string,
    }),
  );
  expect(error.details).toEqual({
    reason: "SOURCE_NOT_FOUND",
  });
});

test("names are cut on a character boundary and the list size is capped", () => {
  expect(truncateName("a".repeat(300))).toHaveLength(MAX_SOURCE_NAME_CHARS);
  // The last allowed unit would be the first half of a surrogate pair.
  const cut = truncateName(`${"a".repeat(MAX_SOURCE_NAME_CHARS - 1)}\u{1F600}`);
  expect(cut).toHaveLength(MAX_SOURCE_NAME_CHARS - 1);
  const windows: Array<
    [
      bigint,
      WindowFacts,
    ]
  > = [];
  for (let at = 1; at <= MAX_SOURCES + 2; at += 1) {
    windows.push([
      BigInt(at),
      windowFacts({
        tid: at,
      }),
    ]);
  }
  const error = errorOf(() =>
    setup(windows).adapter.listSources({
      types: [
        "window",
      ],
    }),
  );
  expect(error.code).toBe("INTERNAL");
});

test("capture sizes fit the box without enlarging", () => {
  expect(
    fitSize(
      {
        width: 1920,
        height: 1080,
      },
      150,
      150,
    ),
  ).toEqual({
    width: 150,
    height: 84,
  });
  expect(
    fitSize(
      {
        width: 100,
        height: 50,
      },
      150,
      150,
    ),
  ).toEqual({
    width: 100,
    height: 50,
  });
  expect(
    fitSize(
      {
        width: 4000,
        height: 1,
      },
      100,
      100,
    ),
  ).toEqual({
    width: 100,
    height: 1,
  });
  expect(DEFAULT_CAPTURE_EDGE_PIXELS).toBe(150);
});

test("a screen capture returns a PNG of the requested size and frees every GDI object", () => {
  const { adapter, world, alive } = setup(
    [],
    [
      primary,
    ],
  );
  const [source] = adapter.listSources({
    types: [
      "screen",
    ],
  });
  const image = adapter.captureSource({
    id: source?.id as string,
    maxWidth: 192,
    maxHeight: 192,
  });
  expect([
    image.mime,
    image.width,
    image.height,
  ]).toEqual([
    "image/png",
    192,
    108,
  ]);
  expect(captureOutputSchema.safeParse(image).success).toBe(true);
  const decoded = decodePng(Buffer.from(image.data, "base64"));
  expect([
    decoded.width,
    decoded.height,
  ]).toEqual([
    192,
    108,
  ]);
  // The fake paints B=10, G=20, R=30; the PNG stores RGB.
  expect([
    ...decoded.rgb.subarray(0, 3),
  ]).toEqual([
    30,
    20,
    10,
  ]);
  expect(world.log).toContain("BlitScreen");
  expect(alive.size).toBe(0);
  expect(world.log.at(-1)).toBe("restoreDpi");
});

test("a window capture prints the whole window and copies the visible frame", () => {
  const { adapter, world, alive } = setup([
    [
      1n,
      windowFacts(),
    ],
  ]);
  const [source] = adapter.listSources({
    types: [
      "window",
    ],
  });
  world.log.length = 0;
  const image = adapter.captureSource({
    id: source?.id as string,
  });
  expect([
    image.width,
    image.height,
  ]).toEqual([
    150,
    113,
  ]);
  expect(world.log).toEqual([
    "setDpi",
    "GetDC",
    "CreateCompatibleDC",
    "CreateDIBSection",
    "SelectObject",
    "CreateCompatibleDC",
    "CreateDIBSection",
    "SelectObject",
    "PrintWindow",
    "GdiFlush",
    "BlitWindow",
    "GdiFlush",
    // Objects are released in reverse order of creation.
    "SelectObject",
    "DeleteObject",
    "DeleteDC",
    "SelectObject",
    "DeleteObject",
    "DeleteDC",
    "ReleaseDC",
    "restoreDpi",
  ]);
  expect(alive.size).toBe(0);
});

test("capture refuses windows that cannot be captured with a stable reason", () => {
  const cases: Array<
    [
      Partial<WindowFacts>,
      string,
      string,
    ]
  > = [
    [
      {
        minimized: true,
      },
      "INVALID_ARGUMENT",
      "SOURCE_UNAVAILABLE",
    ],
    [
      {
        cloaked: true,
      },
      "INVALID_ARGUMENT",
      "SOURCE_UNAVAILABLE",
    ],
    [
      {
        displayAffinity: 0x11,
      },
      "PERMISSION_DENIED",
      "SOURCE_PROTECTED",
    ],
    [
      {
        displayAffinity: -1,
      },
      "PERMISSION_DENIED",
      "SOURCE_PROTECTED",
    ],
    [
      {
        hung: true,
      },
      "BUSY",
      "SOURCE_NOT_RESPONDING",
    ],
    [
      {
        windowRect: {
          x: 0,
          y: 0,
          width: 7681,
          height: 4320,
        },
        frameRect: null,
      },
      "INVALID_ARGUMENT",
      "CAPTURE_TOO_LARGE",
    ],
  ];
  for (const [change, code, reason] of cases) {
    const { adapter, world, alive } = setup([
      [
        1n,
        windowFacts(),
      ],
    ]);
    const [source] = adapter.listSources({
      types: [
        "window",
      ],
    });
    world.windows.set(1n, windowFacts(change));
    const error = errorOf(() =>
      adapter.captureSource({
        id: source?.id as string,
      }),
    );
    expect([
      error.code,
      error.details,
    ]).toEqual([
      code,
      {
        reason,
      },
    ]);
    expect(alive.size).toBe(0);
    expect(world.log.at(-1)).toBe("restoreDpi");
  }
});

test("a monitor that disappeared is reported as not found", () => {
  const { adapter, world } = setup(
    [],
    [
      primary,
    ],
  );
  const [source] = adapter.listSources({
    types: [
      "screen",
    ],
  });
  world.monitors = [];
  const error = errorOf(() =>
    adapter.captureSource({
      id: source?.id as string,
    }),
  );
  expect(error.details).toEqual({
    reason: "SOURCE_NOT_FOUND",
  });
});

test("a failure at any native step releases what was acquired and restores DPI awareness", () => {
  const steps = [
    "GetDC",
    "CreateCompatibleDC",
    "CreateDIBSection",
    "SelectObject",
    "PrintWindow",
    "BlitWindow",
  ];
  for (const failOn of steps) {
    const { adapter, world, alive } = setup([
      [
        1n,
        windowFacts(),
      ],
    ]);
    const [source] = adapter.listSources({
      types: [
        "window",
      ],
    });
    world.failOn = failOn;
    const error = (() => {
      try {
        adapter.captureSource({
          id: source?.id as string,
        });
      } catch (caught) {
        return caught;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(Error);
    expect(alive.size).toBe(0);
    expect(world.log.at(-1)).toBe("restoreDpi");
  }
});

test("release failures are reported together after a successful draw", () => {
  const { adapter, world } = setup(
    [],
    [
      primary,
    ],
  );
  const [source] = adapter.listSources({
    types: [
      "screen",
    ],
  });
  world.failOn = "ReleaseDC";
  const error = (() => {
    try {
      adapter.captureSource({
        id: source?.id as string,
      });
    } catch (caught) {
      return caught;
    }
    return undefined;
  })();
  expect(error).toBeInstanceOf(AggregateError);
  expect(world.log.at(-1)).toBe("restoreDpi");
});

test("a rejected DPI switch fails the call before any GDI work", () => {
  const { adapter, world } = setup(
    [],
    [
      primary,
    ],
  );
  world.failOn = "setDpi";
  expect(
    errorOf(() =>
      adapter.listSources({
        types: [
          "screen",
        ],
      }),
    ).code,
  ).toBe("INTERNAL");
  expect(world.log).toEqual([
    "setDpi",
  ]);
});

test("a disposed adapter refuses calls, closes its libraries once and may be disposed again", () => {
  const { adapter, released } = setup(
    [],
    [
      primary,
    ],
  );
  adapter.dispose();
  adapter.dispose();
  expect(released()).toBe(1);
  expect(
    errorOf(() =>
      adapter.listSources({
        types: [
          "screen",
        ],
      }),
    ).code,
  ).toBe("CANCELLED");
  expect(
    errorOf(() =>
      adapter.captureSource({
        id: crypto.randomUUID(),
      }),
    ).code,
  ).toBe("CANCELLED");
});

test("an unknown source id is not found", () => {
  const { adapter } = setup();
  const error = errorOf(() =>
    adapter.captureSource({
      id: crypto.randomUUID(),
    }),
  );
  expect(error.details).toEqual({
    reason: "SOURCE_NOT_FOUND",
  });
});

test("a PNG over the byte limit is refused instead of truncated", () => {
  const { adapter, world, alive } = setup(
    [],
    [
      primary,
    ],
  );
  world.noise = true;
  const [source] = adapter.listSources({
    types: [
      "screen",
    ],
  });
  const error = errorOf(() =>
    adapter.captureSource({
      id: source?.id as string,
      maxWidth: 1024,
      maxHeight: 1024,
    }),
  );
  expect([
    error.code,
    error.details,
  ]).toEqual([
    "INVALID_ARGUMENT",
    {
      reason: "CAPTURE_TOO_LARGE",
    },
  ]);
  expect(alive.size).toBe(0);
  expect(MAX_CAPTURE_PNG_BYTES).toBe(655_360);
});

test("the PNG encoder writes valid chunks and round-trips pixels", () => {
  const width = 5;
  const height = 3;
  const bgrx = new Uint8Array(width * height * 4);
  for (let at = 0; at < width * height; at += 1) {
    bgrx.set(
      [
        at * 7,
        at * 11,
        255 - at * 5,
        0xaa,
      ],
      at * 4,
    );
  }
  const png = encodePng(bgrx, width, height);
  const decoded = decodePng(png);
  expect([
    decoded.width,
    decoded.height,
  ]).toEqual([
    width,
    height,
  ]);
  for (let at = 0; at < width * height; at += 1) {
    expect([
      ...decoded.rgb.subarray(at * 3, at * 3 + 3),
    ]).toEqual([
      255 - at * 5,
      at * 11,
      at * 7,
    ]);
  }
  expect([
    ...decoded.chunks.keys(),
  ]).toEqual([
    "IHDR",
    "IDAT",
    "IEND",
  ]);
});
