import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import type { WindowSpec } from "../../packages/runtime-bun/src/window-config.ts";
import {
  WindowOperations,
  type WindowState,
} from "../../plugins/windows/src/coordinator.ts";

const WINDOW_READY_TIMEOUT_MS = 30_000;
const CLEANUP_TIMEOUT_ADVANCE_MS = 40_000;

function fixture() {
  const specs: WindowSpec[] = [
    "main",
    "editor",
  ].map((view) => ({
    view,
    title: view,
    home: "https://app.bunaway.local/index.html",
    window: {
      width: 800,
      height: 600,
    },
  }));
  const views = new Map<string, WindowState>();
  function requireView(id: string): WindowState {
    const view = views.get(id);
    assert(view);
    return view;
  }
  let allowClose = true;
  let stopping = false;
  let cancelled = false;
  let nowMs = 0;
  let tick = async () => {};
  const created: string[] = [];
  const operations = new WindowOperations(specs, {
    read: (id) => views.get(id),
    create: (spec) => {
      created.push(spec.view);
      views.set(spec.view, {
        closed: false,
        cleaned: false,
        ready: true,
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
    apply: (call, id) => {
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

const grants = [
  "main",
  "editor",
];
test("window catalog filters grants and cannot open arbitrary or unauthorized views", async () => {
  const f = fixture();
  expect(
    await f.operations.execute(
      {
        operation: "windows.list",
        payload: null,
      },
      [
        "editor",
      ],
      "1",
    ),
  ).toEqual([
    {
      view: "editor",
      open: false,
    },
  ]);
  await expect(
    f.operations.execute(
      {
        operation: "windows.create",
        payload: {
          view: "main",
        },
      },
      [
        "editor",
      ],
      "2",
    ),
  ).rejects.toMatchObject({
    code: "PERMISSION_DENIED",
  });
  await expect(
    f.operations.execute(
      {
        operation: "windows.create",
        payload: {
          view: "unknown",
        },
      },
      [
        "unknown",
      ],
      "3",
    ),
  ).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  });
  expect(f.created).toEqual([]);
});

test("recreation reserves the last window through cleanup, rejects competing creation, and survives old-context cancellation", async () => {
  const f = fixture();
  await f.operations.execute(
    {
      operation: "windows.create",
      payload: {
        view: "main",
      },
    },
    grants,
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
      payload: {
        view: "main",
      },
    },
    grants,
    "2",
  );
  expect(original.closed).toBe(true);
  expect(f.operations.replacing.has("main")).toBe(true);
  expect(f.created).toEqual([
    "main",
  ]);
  await expect(
    f.operations.execute(
      {
        operation: "windows.create",
        payload: {
          view: "main",
        },
      },
      grants,
      "3",
    ),
  ).rejects.toMatchObject({
    code: "BUSY",
  });
  f.cancel();
  original.cleaned = true;
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
      payload: {
        view: "main",
      },
    },
    grants,
    "1",
  );
  f.setClose(false);
  expect(
    await f.operations.execute(
      {
        operation: "windows.close",
        payload: {
          view: "main",
        },
      },
      grants,
      "2",
    ),
  ).toBe(false);
  await expect(
    f.operations.execute(
      {
        operation: "windows.recreate",
        payload: {
          view: "main",
        },
      },
      grants,
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
    f.views.set("editor", {
      closed: true,
      cleaned: false,
      ready: true,
      failure: undefined,
      deadline: 30000,
    });
    f.setTick(async () => {
      f.cancel();
      const previous = f.views.get("editor");
      assert(previous);
      previous.cleaned = true;
    });
    await expect(
      f.operations.execute(
        {
          operation,
          payload: {
            view: "editor",
          },
        },
        grants,
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
        payload: {
          view: "main",
        },
      },
      grants,
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
        payload: {
          view: "main",
        },
      },
      grants,
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
          payload: {
            view: "main",
          },
        },
        grants,
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
