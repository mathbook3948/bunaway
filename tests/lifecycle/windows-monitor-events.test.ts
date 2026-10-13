import { expect, test } from "bun:test";
import type { NativeMonitorChange } from "@bunaway/plugin-api/native";
import {
  isMonitorChangeMessage,
  MonitorTracker,
} from "#native/windows/bun/monitor-events";
import { fixtureMonitor } from "../fixtures/monitors.ts";

function controlledTracker() {
  let monitors = [
    fixtureMonitor("display-b"),
    fixtureMonitor("display-a"),
  ];
  let failure: unknown;
  let reads = 0;
  const events: NativeMonitorChange[] = [];
  const errors: unknown[] = [];
  const tracker = new MonitorTracker(
    () => {
      reads++;
      if (failure) {
        throw failure;
      }
      return monitors;
    },
    (event) => events.push(event),
    (error) => errors.push(error),
  );
  return {
    tracker,
    events,
    errors,
    reads: () => reads,
    set: (next: typeof monitors) => {
      monitors = next;
    },
    fail: (error?: unknown) => {
      failure = error;
    },
  };
}

test("monitor observation starts at revision zero without replay and never polls a clean batch", () => {
  const state = controlledTracker();
  const initial = state.tracker.snapshot();
  expect(initial.sourceId).toMatch(/^[a-f0-9-]{36}$/);
  expect(initial.revision).toBe(0);
  expect(initial.error).toBeNull();
  expect(initial.monitors.map(({ id }) => id)).toEqual([
    "display-a",
    "display-b",
  ]);
  state.tracker.flush();
  state.tracker.flush();
  expect(state.reads()).toBe(1);
  expect(state.events).toHaveLength(0);
  state.set(
    [
      ...initial.monitors,
    ].reverse(),
  );
  state.tracker.invalidate();
  state.tracker.flush();
  expect(state.events).toHaveLength(0);
  expect(state.tracker.snapshot()).toEqual(initial);
  expect(
    new MonitorTracker(
      () => [],
      () => {},
    ).snapshot().sourceId,
  ).not.toBe(initial.sourceId);
});

test("monitor batches coalesce add, remove and metric changes by id, and snapshots recover missed notifications", () => {
  const state = controlledTracker();
  const initial = state.tracker.snapshot();
  state.set([
    fixtureMonitor("display-c"),
    {
      ...fixtureMonitor("display-a"),
      dpi: 192,
      scaleFactor: 2,
    },
  ]);
  for (let count = 0; count < 10; count++) {
    state.tracker.invalidate();
  }
  state.tracker.flush();
  expect(state.reads()).toBe(2);
  expect(state.events).toEqual([
    {
      sourceId: initial.sourceId,
      revision: 1,
      added: [
        "display-c",
      ],
      removed: [
        "display-b",
      ],
      changed: [
        "display-a",
      ],
      error: null,
    },
  ]);
  state.tracker.flush();
  expect(state.reads()).toBe(2);
  state.set([
    fixtureMonitor("display-a"),
  ]);
  const recovered = state.tracker.snapshot();
  expect(recovered.revision).toBe(2);
  expect(state.events.at(-1)).toEqual({
    sourceId: initial.sourceId,
    revision: 2,
    added: [],
    removed: [
      "display-c",
    ],
    changed: [
      "display-a",
    ],
    error: null,
  });
});

test("failed enumeration retains valid monitors, sanitizes diagnostics, suppresses repeated failure and versions recovery", () => {
  const state = controlledTracker();
  const initial = state.tracker.snapshot();
  const cause = new Error(`private diagnostic ${"secret".repeat(2000)}`);
  state.fail(cause);
  const failed = state.tracker.snapshot();
  expect(failed.monitors).toEqual(initial.monitors);
  expect(failed.revision).toBe(1);
  expect(failed.error).toEqual({
    code: "INTERNAL",
    message: "Display information is unavailable.",
  });
  expect(state.errors).toEqual([
    cause,
  ]);
  expect(state.events).toEqual([
    {
      sourceId: initial.sourceId,
      revision: 1,
      added: [],
      removed: [],
      changed: [],
      error: failed.error,
    },
  ]);
  expect(state.tracker.snapshot()).toEqual(failed);
  expect(state.events).toHaveLength(1);
  state.fail();
  const recovered = state.tracker.snapshot();
  expect(recovered).toEqual({
    ...initial,
    revision: 2,
  });
  expect(state.events.at(-1)).toEqual({
    sourceId: initial.sourceId,
    revision: 2,
    added: [],
    removed: [],
    changed: [],
    error: null,
  });
});

test("snapshot mutation and mutable enumeration buffers cannot alter retained monitor state", () => {
  const state = controlledTracker();
  const monitors = [
    fixtureMonitor(),
  ];
  state.set(monitors);
  const initial = state.tracker.snapshot();
  const initialMonitor = initial.monitors[0];
  if (!initialMonitor) {
    throw new Error("Missing initial fixture monitor");
  }
  initialMonitor.bounds.x = 1;
  initial.monitors.length = 0;
  state.fail(new Error("offline"));
  expect(state.tracker.snapshot().monitors).toEqual(monitors);
  const mutableMonitor = monitors[0];
  if (!mutableMonitor) {
    throw new Error("Missing mutable fixture monitor");
  }
  mutableMonitor.name = "Changed externally";
  expect(state.tracker.snapshot().monitors[0]?.name).not.toBe(
    "Changed externally",
  );
});

test("initial enumeration failure has no fabricated monitors or replay and recovery adds the first display", () => {
  const state = controlledTracker();
  state.fail(new Error("offline"));
  const initial = state.tracker.snapshot();
  expect(initial.monitors).toEqual([]);
  expect(initial.revision).toBe(0);
  expect(initial.error?.code).toBe("INTERNAL");
  expect(state.events).toEqual([]);
  state.fail();
  expect(state.tracker.snapshot().revision).toBe(1);
  expect(state.events.at(-1)).toMatchObject({
    added: [
      "display-a",
      "display-b",
    ],
    removed: [],
    changed: [],
    error: null,
  });
});

test.skipIf(process.platform !== "win32")(
  "actual hidden HWND display notifications coalesce synthetic monitor changes without showing a window",
  async () => {
    const [{ Windows }, { dlopen }] = await Promise.all([
      import("#native/windows/bun/win32"),
      import("bun:ffi"),
    ]);
    const windows = new Windows(() => {});
    const driver = dlopen("user32.dll", {
      SendMessageW: {
        args: [
          "u64",
          "u32",
          "u64",
          "i64",
        ],
        returns: "i64",
      },
    });
    const state = controlledTracker();
    let hwnd = 0n;
    try {
      const initial = state.tracker.snapshot();
      hwnd = windows.create(
        "Synthetic display notification regression",
        200,
        200,
        (message) => {
          if (isMonitorChangeMessage(message)) {
            state.tracker.invalidate();
          }
        },
        false,
      );
      expect(windows.isVisible(hwnd)).toBe(false);
      driver.symbols.SendMessageW(hwnd, 0x0000, 0n, 0n);
      windows.pump();
      state.tracker.flush();
      expect(state.reads()).toBe(1);
      state.set([
        {
          ...fixtureMonitor("display-a"),
          name: "Synthetic metadata",
        },
      ]);
      for (const message of [
        0x007e,
        0x001a,
        0x0219,
      ]) {
        driver.symbols.SendMessageW(hwnd, message, 0n, 0n);
      }
      expect(state.events).toEqual([]);
      windows.pump();
      state.tracker.flush();
      expect(state.reads()).toBe(2);
      expect(state.events).toEqual([
        {
          sourceId: initial.sourceId,
          revision: 1,
          added: [],
          removed: [
            "display-b",
          ],
          changed: [
            "display-a",
          ],
          error: null,
        },
      ]);
      driver.symbols.SendMessageW(hwnd, 0x007e, 0n, 0n);
      windows.pump();
      state.tracker.flush();
      expect(state.events).toHaveLength(1);
      expect(windows.isVisible(hwnd)).toBe(false);
      windows.destroy(hwnd);
      hwnd = 0n;
      windows.pump();
      state.tracker.flush();
      expect(state.events).toHaveLength(1);
    } finally {
      if (hwnd) {
        windows.destroy(hwnd);
      }
      windows.dispose();
      driver.close();
    }
  },
);
