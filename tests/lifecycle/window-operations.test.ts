import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { BunawayError } from "@bunaway/protocol";
import type { WindowSpec } from "@bunaway/runtime-bun/window-config";
import {
  WindowOperations,
  type WindowState,
} from "#plugins/windows/src/platforms/coordinator";

const WINDOW_READY_TIMEOUT_MS = 30_000;
const CLEANUP_TIMEOUT_ADVANCE_MS = 40_000;

test("initial state overrides are fieldwise and recreation restores declared state", async () => {
  const f = fixture();
  const main = f.specs[0];
  assert(main);
  main.window = {
    ...main.window,
    maximized: true,
    fullscreen: true,
    titlebar: "custom",
    alwaysOnTop: true,
    skipTaskbar: true,
    contentProtection: true,
  };
  await f.operations.execute(
    {
      operation: "windows.create",
      payload: {
        options: {
          window: {
            fullscreen: false,
            titlebar: "system",
            alwaysOnTop: false,
            skipTaskbar: false,
            contentProtection: false,
          },
        },
      },
    },
    "initial-state",
  );
  expect(f.createdSpecs[0]?.window).toEqual({
    ...main.window,
    fullscreen: false,
    titlebar: "system",
    alwaysOnTop: false,
    skipTaskbar: false,
    contentProtection: false,
  });
  const first = f.views.get("main");
  assert(first);
  f.setTick(async () => {
    first.cleaned = true;
  });
  await f.operations.execute(
    {
      operation: "windows.recreate",
      payload: {},
    },
    "declared-state",
  );
  expect(f.createdSpecs[1]?.window).toEqual(main.window);
  expect(main.window.fullscreen).toBe(true);
});

/** Build a controllable host so tests can pause cleanup and advance deadlines. */
function fixture(
  supportsDestroy = true,
  supportsCreationOptions = true,
  validateCreation?: (spec: WindowSpec) => void,
) {
  const specs: WindowSpec[] = [
    {
      view: "main",
      title: "main",
      home: "https://app.bunaway.local/index.html",
      window: {
        width: 800,
        height: 600,
      },
    },
  ];
  const views = new Map<string, WindowState>();
  function requireView(id: string): WindowState {
    const view = views.get(id);
    assert(view);
    return view;
  }
  let allowClose = true;
  let creationReady = true;
  let stopping = false;
  let cancelled = false;
  let nowMs = 0;
  let tick = async () => {};
  const created: string[] = [];
  const createdSpecs: WindowSpec[] = [];
  const destroyed: string[] = [];
  const destroy = (id: string) => {
    destroyed.push(id);
    requireView(id).closed = true;
    return true;
  };
  const operations = new WindowOperations(specs, {
    supportsCreationOptions,
    ...(validateCreation
      ? {
          validateCreation,
        }
      : {}),
    read: (id) => views.get(id),
    create: (spec) => {
      created.push(spec.view);
      createdSpecs.push(spec);
      views.set(spec.view, {
        closed: false,
        cleaned: false,
        ready: creationReady,
        failure: undefined,
        deadline: nowMs + WINDOW_READY_TIMEOUT_MS,
      });
    },
    close: (id) => {
      if (allowClose) {
        requireView(id).closed = true;
      }
      return allowClose;
    },
    ...(supportsDestroy
      ? {
          destroy,
        }
      : {}),
    apply: (call, id) => {
      if (call.operation === "windows.destroy") {
        if (!supportsDestroy) {
          throw new BunawayError({
            code: "UNSUPPORTED",
            message:
              "Trusted window destruction is not implemented on this platform.",
          });
        }
        return destroy(id);
      }
      if (call.operation !== "windows.close") {
        return null;
      }
      if (allowClose) {
        requireView(id).closed = true;
      }
      return allowClose;
    },
    stopping: () => stopping,
    cancelled: () => cancelled,
    now: () => nowMs,
    tick: () => tick(),
  });
  return {
    operations,
    views,
    created,
    createdSpecs,
    specs,
    destroyed,
    setCreationReady: (value: boolean) => {
      creationReady = value;
    },
    setClose: (value: boolean) => {
      allowClose = value;
    },
    stop: () => {
      stopping = true;
    },
    cancel: () => {
      cancelled = true;
    },
    setTick: (value: () => Promise<void>) => {
      tick = value;
    },
    advancePastCleanupDeadline: () => {
      nowMs += CLEANUP_TIMEOUT_ADVANCE_MS;
    },
  };
}

test("merged placement errors preserve the existing HWND and do not reserve a replacement", async () => {
  const f = fixture();
  await f.operations.execute(
    {
      operation: "windows.create",
      payload: {},
    },
    "initial",
  );
  const original = f.views.get("main");
  for (const window of [
    {
      x: 10,
    },
    {
      x: 10,
      y: 20,
      center: true,
    },
    {
      x: null,
      y: 20,
    },
  ]) {
    await expect(
      f.operations.execute(
        {
          operation: "windows.recreate",
          payload: {
            options: {
              window,
            },
          },
        },
        "invalid",
      ),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    expect(f.views.get("main")).toBe(original);
    expect(original?.closed).toBe(false);
    expect(f.operations.replacing.size).toBe(0);
    expect(f.created).toEqual([
      "main",
    ]);
  }
});

test("display-dependent validation fails before reservation and close and leaves capacity usable", async () => {
  const f = fixture(true, true, (spec) => {
    expect(f.operations.replacing.size).toBe(0);
    if (spec.window.preventOverflow) {
      throw new BunawayError({
        code: "INVALID_ARGUMENT",
        message: "Minimum cannot fit.",
      });
    }
  });
  await f.operations.execute(
    {
      operation: "windows.create",
      payload: {},
    },
    "initial",
  );
  await expect(
    f.operations.execute(
      {
        operation: "windows.recreate",
        payload: {
          options: {
            window: {
              preventOverflow: true,
            },
          },
        },
      },
      "invalid",
    ),
  ).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  });
  expect(f.views.get("main")?.closed).toBe(false);
  expect(f.operations.replacing.size).toBe(0);
  expect(f.created).toEqual([
    "main",
  ]);
});

test("per-call placement merges axes and clears declared coordinates without changing declarations", async () => {
  const f = fixture();
  const spec = f.specs[0];
  assert(spec);
  spec.window = {
    ...spec.window,
    x: -800,
    y: -100,
  };
  await f.operations.execute(
    {
      operation: "windows.create",
      payload: {
        options: {
          window: {
            x: -600,
            useContentSize: false,
            width: 400,
            minWidth: 800,
          },
        },
      },
    },
    "initial",
  );
  expect(f.createdSpecs[0]?.window).toMatchObject({
    x: -600,
    y: -100,
    width: 400,
    useContentSize: false,
  });
  const first = f.views.get("main");
  assert(first);
  first.cleaned = true;
  await f.operations.execute(
    {
      operation: "windows.recreate",
      payload: {
        options: {
          window: {
            x: null,
            y: null,
            center: true,
          },
        },
      },
    },
    "center",
  );
  expect(f.createdSpecs[1]?.window).toMatchObject({
    x: null,
    y: null,
    center: true,
  });
  const centered = f.views.get("main");
  assert(centered);
  centered.cleaned = true;
  await f.operations.execute(
    {
      operation: "windows.recreate",
      payload: {},
    },
    "restore",
  );
  expect(f.createdSpecs[2]?.window).toEqual(spec.window);
  expect(spec.window).toEqual({
    width: 800,
    height: 600,
    x: -800,
    y: -100,
  });
});

test("cancelling a newly created hidden window while its controller prepares closes the owned window", async () => {
  const f = fixture();
  f.setCreationReady(false);
  f.setClose(false);
  f.setTick(async () => {
    f.cancel();
  });
  await expect(
    f.operations.execute(
      {
        operation: "windows.create",
        payload: {},
      },
      "new",
    ),
  ).rejects.toMatchObject({
    code: "CANCELLED",
  });
  expect(f.views.get("main")?.closed).toBe(true);
  expect(f.destroyed).toEqual([
    "main",
  ]);
  expect(f.operations.replacing.size).toBe(0);
});

test("unsupported destruction leaves an already committed recreation running", async () => {
  const f = fixture(false);
  await f.operations.execute(
    {
      operation: "windows.create",
      payload: {},
    },
    "initial",
  );
  const original = f.views.get("main");
  assert(original);
  let wake: (() => void) | undefined;
  f.setTick(
    () =>
      new Promise<void>((resolve) => {
        wake = resolve;
      }),
  );
  const replacement = f.operations.execute(
    {
      operation: "windows.recreate",
      payload: {},
    },
    "replacement",
  );
  await Promise.resolve();
  assert(wake);
  await expect(
    f.operations.execute(
      {
        operation: "windows.destroy",
        payload: null,
      },
      "unsupported",
    ),
  ).rejects.toMatchObject({
    code: "UNSUPPORTED",
  });
  original.cleaned = true;
  wake();
  expect(await replacement).toBeNull();
  expect(f.created).toEqual([
    "main",
    "main",
  ]);
  expect(f.views.get("main")?.closed).toBe(false);
  expect(f.destroyed).toEqual([]);
  expect(f.operations.replacing.size).toBe(0);
});

test("trusted destruction interrupts an already committed recreation without resurrecting its window", async () => {
  const f = fixture();
  await f.operations.execute(
    {
      operation: "windows.create",
      payload: {},
    },
    "initial",
  );
  const original = f.views.get("main");
  assert(original);
  let wake: (() => void) | undefined;
  f.setTick(
    () =>
      new Promise<void>((resolve) => {
        wake = resolve;
      }),
  );
  const replacement = f.operations.execute(
    {
      operation: "windows.recreate",
      payload: {},
    },
    "replacement",
  );
  await Promise.resolve();
  assert(wake);
  expect(
    await f.operations.execute(
      {
        operation: "windows.destroy",
        payload: null,
      },
      "force",
    ),
  ).toBe(true);
  wake();
  await expect(replacement).rejects.toMatchObject({
    code: "CANCELLED",
  });
  expect(f.created).toEqual([
    "main",
  ]);
  expect(f.operations.replacing.size).toBe(0);
});

test("failed controller creation uses trusted cleanup even when normal close would refuse", async () => {
  const f = fixture();
  f.setClose(false);
  f.setCreationReady(false);
  f.setTick(async () => {
    const view = f.views.get("main");
    assert(view);
    view.failure = new Error("Controller failed");
  });
  await expect(
    f.operations.execute(
      {
        operation: "windows.create",
        payload: {},
      },
      "failed",
    ),
  ).rejects.toMatchObject({
    code: "INTERNAL",
  });
  expect(f.views.get("main")?.closed).toBe(true);
  expect(f.destroyed).toEqual([
    "main",
  ]);
});

test("parent termination cancels child recreation but permits a later explicit unowned creation", async () => {
  const f = fixture();
  await f.operations.execute(
    {
      operation: "windows.create",
      payload: {},
    },
    "initial",
  );
  f.setTick(async () => {
    const original = f.views.get("main");
    assert(original);
    original.replacementCancelled = true;
    original.cleaned = true;
  });
  await expect(
    f.operations.execute(
      {
        operation: "windows.recreate",
        payload: {},
      },
      "recreation",
    ),
  ).rejects.toMatchObject({
    code: "CANCELLED",
  });
  expect(f.created).toEqual([
    "main",
  ]);
  await f.operations.execute(
    {
      operation: "windows.create",
      payload: {},
    },
    "explicit",
  );
  expect(f.created).toEqual([
    "main",
    "main",
  ]);
});
test.each([
  false,
  true,
])(
  "parent termination during replacement controller setup reports cancellation even when ready=%j",
  async (ready) => {
    const f = fixture();
    await f.operations.execute(
      {
        operation: "windows.create",
        payload: {},
      },
      "initial",
    );
    const original = f.views.get("main");
    assert(original);
    f.setCreationReady(false);
    f.setTick(async () => {
      const current = f.views.get("main");
      assert(current);
      if (current === original) {
        current.cleaned = true;
      } else {
        current.ready = ready;
        current.replacementCancelled = true;
        current.closed = true;
      }
    });
    await expect(
      f.operations.execute(
        {
          operation: "windows.recreate",
          payload: {},
        },
        "replacement",
      ),
    ).rejects.toMatchObject({
      code: "CANCELLED",
    });
    expect(f.created).toEqual([
      "main",
      "main",
    ]);
    expect(f.views.get("main")?.closed).toBe(true);
    expect(f.operations.replacing.size).toBe(0);
  },
);

test("trusted destroy after controller readiness but before recreation resumes reports cancellation", async () => {
  const f = fixture();
  await f.operations.execute(
    {
      operation: "windows.create",
      payload: {},
    },
    "initial",
  );
  const original = f.views.get("main");
  assert(original);
  f.setCreationReady(false);
  f.setTick(async () => {
    const current = f.views.get("main");
    assert(current);
    if (current === original) {
      current.cleaned = true;
    } else {
      current.ready = true;
      expect(
        await f.operations.execute(
          {
            operation: "windows.destroy",
            payload: null,
          },
          "destroy",
        ),
      ).toBe(true);
    }
  });
  await expect(
    f.operations.execute(
      {
        operation: "windows.recreate",
        payload: {},
      },
      "replacement",
    ),
  ).rejects.toMatchObject({
    code: "CANCELLED",
  });
  expect(f.views.get("main")?.closed).toBe(true);
  expect(f.operations.replacing.size).toBe(0);
});

test("creating while the window is open is BUSY and preserves its window and session owner", async () => {
  const f = fixture();
  const call = {
    operation: "windows.create",
    payload: {},
  } as const;
  await f.operations.execute(call, "first");
  const original = f.views.get("main");
  await expect(f.operations.execute(call, "second")).rejects.toMatchObject({
    code: "BUSY",
    message: expect.stringContaining("Window is already open"),
  });
  expect(f.views.get("main")).toBe(original);
  expect(f.created).toEqual([
    "main",
  ]);
  expect(f.destroyed).toEqual([]);
  expect(original?.closed).toBe(false);
});

test("recreation reserves the last window through cleanup, rejects competing creation, and survives old-context cancellation", async () => {
  const f = fixture();
  await f.operations.execute(
    {
      operation: "windows.create",
      payload: {},
    },
    "1",
  );
  const original = f.views.get("main");
  assert(original);
  let release!: () => void;
  f.setTick(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const recreation = f.operations.execute(
    {
      operation: "windows.recreate",
      payload: {},
    },
    "2",
  );
  expect(original.closed).toBe(true);
  expect(f.operations.replacing.has("main")).toBe(true);
  await expect(
    f.operations.execute(
      {
        operation: "windows.isNormal",
        payload: null,
      },
      "state",
    ),
  ).rejects.toMatchObject({
    code: "BUSY",
  });
  expect(f.created).toEqual([
    "main",
  ]);
  await expect(
    f.operations.execute(
      {
        operation: "windows.create",
        payload: {},
      },
      "3",
    ),
  ).rejects.toMatchObject({
    code: "BUSY",
  });
  f.cancel();
  original.cleaned = true;
  // Finish old-window cleanup after its context is cancelled before replacement.
  release();
  await recreation;
  expect(f.created).toEqual([
    "main",
    "main",
  ]);
  expect(f.views.get("main")).not.toBe(original);
  expect(f.operations.replacing.size).toBe(0);
});

test("close refusal preserves the existing window and recreation releases its reservation", async () => {
  const f = fixture();
  await f.operations.execute(
    {
      operation: "windows.create",
      payload: {},
    },
    "1",
  );
  f.setClose(false);
  expect(
    await f.operations.execute(
      {
        operation: "windows.close",
        payload: null,
      },
      "2",
    ),
  ).toBe(false);
  await expect(
    f.operations.execute(
      {
        operation: "windows.recreate",
        payload: {},
      },
      "3",
    ),
  ).rejects.toMatchObject({
    code: "CANCELLED",
  });
  expect(f.views.get("main")?.closed).toBe(false);
  expect(f.created).toEqual([
    "main",
  ]);
  expect(f.operations.replacing.size).toBe(0);
});

test("cancelling creation while an already closed window drains prevents a new window", async () => {
  for (const operation of [
    "windows.create",
    "windows.recreate",
  ] as const) {
    const f = fixture();
    f.views.set("main", {
      closed: true,
      cleaned: false,
      ready: true,
      failure: undefined,
      deadline: 30000,
    });
    f.setTick(async () => {
      f.cancel();
      const previous = f.views.get("main");
      assert(previous);
      previous.cleaned = true;
    });
    await expect(
      f.operations.execute(
        {
          operation,
          payload: {},
        },
        "1",
      ),
    ).rejects.toMatchObject({
      code: "CANCELLED",
    });
    expect(f.created).toEqual([]);
    expect(f.operations.replacing.size).toBe(0);
  }
});

test("shutdown, cancellation before creation and cleanup timeout do not create replacement windows", async () => {
  const cancelled = fixture();
  cancelled.cancel();
  await expect(
    cancelled.operations.execute(
      {
        operation: "windows.create",
        payload: {},
      },
      "1",
    ),
  ).rejects.toMatchObject({
    code: "CANCELLED",
  });
  expect(cancelled.created).toEqual([]);
  for (const shutdown of [
    true,
    false,
  ]) {
    const f = fixture();
    await f.operations.execute(
      {
        operation: "windows.create",
        payload: {},
      },
      "1",
    );
    f.setTick(async () => {
      if (shutdown) {
        f.stop();
      } else {
        f.advancePastCleanupDeadline();
      }
    });
    await expect(
      f.operations.execute(
        {
          operation: "windows.recreate",
          payload: {},
        },
        "2",
      ),
    ).rejects.toMatchObject({
      code: "CANCELLED",
    });
    expect(f.created).toEqual([
      "main",
    ]);
    expect(f.operations.replacing.size).toBe(0);
  }
});

test("creation options clamp merged constraints and restore declaration defaults on recreation", async () => {
  const f = fixture();
  const spec = f.specs[0];
  assert(spec);
  spec.showWhenReady = "sdk";
  spec.window.minWidth = 900;
  spec.window.maxWidth = 1200;
  await f.operations.execute(
    {
      operation: "windows.create",
      payload: {
        options: {
          title: "Draft",
          visible: false,
          showWhenReady: null,
          window: {
            width: 1500,
            minWidth: null,
          },
        },
      },
    },
    "options",
  );
  expect(f.createdSpecs[0]).toMatchObject({
    title: "Draft",
    visible: false,
    window: {
      width: 1200,
      height: 600,
      minWidth: null,
      maxWidth: 1200,
    },
  });
  expect(f.createdSpecs[0]).not.toHaveProperty("showWhenReady");
  expect(spec.title).toBe("main");
  expect(spec.window.width).toBe(800);
  f.setTick(async () => {
    const state = f.views.get("main");
    assert(state);
    state.cleaned = true;
  });
  await f.operations.execute(
    {
      operation: "windows.recreate",
      payload: {},
    },
    "defaults",
  );
  expect(f.createdSpecs[1]).toMatchObject({
    title: "main",
    showWhenReady: "sdk",
    window: {
      width: 900,
      minWidth: 900,
    },
  });
  expect(f.createdSpecs[1]).not.toHaveProperty("visible");
});

test("invalid merged creation constraints leave the live window and reservation unchanged", async () => {
  const f = fixture();
  const spec = f.specs[0];
  assert(spec);
  spec.window.minWidth = 1000;
  await f.operations.execute(
    {
      operation: "windows.create",
      payload: {},
    },
    "initial",
  );
  const original = f.views.get("main");
  await expect(
    f.operations.execute(
      {
        operation: "windows.recreate",
        payload: {
          options: {
            window: {
              maxWidth: 900,
            },
          },
        },
      },
      "invalid",
    ),
  ).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  });
  expect(f.views.get("main")).toBe(original);
  expect(original?.closed).toBe(false);
  expect(f.operations.replacing.size).toBe(0);
  expect(f.created).toEqual([
    "main",
  ]);
});

test("platforms without creation options accept empty options and reject overrides before closing", async () => {
  const f = fixture(true, false);
  await f.operations.execute(
    {
      operation: "windows.create",
      payload: {
        options: {},
      },
    },
    "empty",
  );
  await expect(
    f.operations.execute(
      {
        operation: "windows.recreate",
        payload: {
          options: {
            visible: false,
          },
        },
      },
      "unsupported",
    ),
  ).rejects.toMatchObject({
    code: "UNSUPPORTED",
  });
  expect(f.views.get("main")?.closed).toBe(false);
  expect(f.operations.replacing.size).toBe(0);
});

test("creation titles use the same UTF-16 bound as declarations before closing an existing window", async () => {
  const f = fixture();
  await f.operations.execute(
    {
      operation: "windows.create",
      payload: {
        options: {
          title: "😀".repeat(512),
        },
      },
    },
    "valid-title",
  );
  await expect(
    f.operations.execute(
      {
        operation: "windows.recreate",
        payload: {
          options: {
            title: "😀".repeat(513),
          },
        },
      },
      "invalid-title",
    ),
  ).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  });
  expect(f.views.get("main")?.closed).toBe(false);
  expect(f.createdSpecs[0]?.title.length).toBe(1024);
});

test("unsupported native creation retains its capability error and cleans the reserved window", async () => {
  const f = fixture();
  f.setCreationReady(false);
  f.setTick(async () => {
    const view = f.views.get("main");
    assert(view);
    view.failure = new BunawayError({
      code: "UNSUPPORTED",
      message: "Custom titlebars require WebView2 non-client region support.",
    });
  });
  await expect(
    f.operations.execute(
      {
        operation: "windows.create",
        payload: {
          options: {
            window: {
              titlebar: "custom",
            },
          },
        },
      },
      "unsupported-titlebar",
    ),
  ).rejects.toMatchObject({
    code: "UNSUPPORTED",
    message: "Custom titlebars require WebView2 non-client region support.",
  });
  expect(f.operations.replacing.size).toBe(0);
});
