import { expect, test } from "bun:test";
import {
  abandonedCompletionCount,
  EDIT_COMPLETION_GRACE_MS,
  EditCommandCalls,
  MAX_ABANDONED_COMPLETIONS,
  MAX_IN_FLIGHT_EDIT_CALLS,
} from "#native/windows/bun/webview-edit-calls";

/** Stand-in for a COM handler: `refs` is 2 while native holds it, 1 once released. */
type FakeHandler = {
  refs: number;
  invoke(): void;
};

function fixture() {
  const disposed: FakeHandler[] = [];
  const abandoned: FakeHandler[] = [];
  const reclaimed: FakeHandler[] = [];
  const reported: string[] = [];
  const calls = new EditCommandCalls<FakeHandler>({
    dispose: (handlers) => disposed.push(...handlers),
    abandon: (handlers) => abandoned.push(...handlers),
    reclaim: (handlers) => reclaimed.push(...handlers),
  });
  const start = (command: string, effects: string[]): FakeHandler => {
    let created: FakeHandler | undefined;
    calls.start(command, (isActive) => {
      created = {
        refs: 2,
        invoke() {
          // Mirrors the view's callback: nothing runs once the call is inactive.
          if (isActive()) {
            effects.push(command);
          }
        },
      };
      return created;
    });
    if (!created) {
      throw new Error("Call was not started");
    }
    return created;
  };
  const settle = (closedForMs: number) =>
    calls.settle(closedForMs, (command) => reported.push(command));
  return {
    calls,
    disposed,
    abandoned,
    reclaimed,
    reported,
    start,
    settle,
  };
}

test("a completion released by native is disposed and cleanup proceeds immediately", () => {
  const f = fixture();
  const effects: string[] = [];
  const handler = f.start("copy", effects);
  expect(f.settle(0)).toBe(false);
  handler.invoke();
  handler.refs = 1;
  expect(f.settle(0)).toBe(true);
  expect(f.calls.handlers()).toEqual([
    handler,
  ]);
  f.calls.release();
  expect(f.disposed).toEqual([
    handler,
  ]);
  expect(effects).toEqual([
    "copy",
  ]);
  expect(f.abandoned).toEqual([]);
});

test("a call started without pruning leaves released handlers for later", () => {
  const f = fixture();
  const first = f.start("undo", []);
  first.refs = 1;
  f.calls.start(
    "paste",
    () => ({
      refs: 2,
      invoke() {},
    }),
    {
      prune: false,
    },
  );
  expect(f.disposed).toEqual([]);
  f.calls.prune();
  expect(f.disposed).toEqual([
    first,
  ]);
});

test("a handler released without being invoked is pruned before the next command", () => {
  const f = fixture();
  const first = f.start("undo", []);
  first.refs = 1;
  f.start("redo", []);
  expect(f.disposed).toEqual([
    first,
  ]);
});

test("a completion native still holds is abandoned after the grace period and cleanup completes", () => {
  const f = fixture();
  const before = abandonedCompletionCount();
  const handler = f.start("paste", []);
  expect(f.settle(EDIT_COMPLETION_GRACE_MS)).toBe(false);
  expect(f.reported).toEqual([]);
  expect(f.settle(EDIT_COMPLETION_GRACE_MS + 1)).toBe(true);
  // Abandoned handlers are unregistered but never released, so a late Invoke stays safe.
  expect(f.abandoned).toEqual([
    handler,
  ]);
  expect(f.reported).toEqual([
    "paste",
  ]);
  expect(abandonedCompletionCount()).toBe(before + 1);
  expect(f.calls.handlers()).toEqual([]);
  f.calls.release();
  expect(f.disposed).toEqual([]);
});

test("a late invocation after abandonment or release is ignored without throwing", () => {
  const f = fixture();
  const effects: string[] = [];
  const abandonedHandler = f.start("cut", effects);
  const releasedHandler = f.start("selectAll", effects);
  f.settle(EDIT_COMPLETION_GRACE_MS + 1);
  expect(() => abandonedHandler.invoke()).not.toThrow();
  releasedHandler.refs = 1;
  expect(() => releasedHandler.invoke()).not.toThrow();
  expect(effects).toEqual([]);
});

test("a late invocation before cleanup still reports its result", () => {
  const f = fixture();
  const effects: string[] = [];
  const handler = f.start("copy", effects);
  handler.invoke();
  expect(effects).toEqual([
    "copy",
  ]);
});

test("abandonment past the global limit completes cleanup, then new calls are busy until reclaim", () => {
  const f = fixture();
  const room = MAX_ABANDONED_COMPLETIONS - abandonedCompletionCount();
  const handlers: FakeHandler[] = [];
  const overLimit: boolean[] = [];
  const settleAll = () =>
    f.calls.settle(EDIT_COMPLETION_GRACE_MS + 1, (_command, _total, over) =>
      overLimit.push(over),
    );
  for (let index = 0; index < room + 2; index++) {
    handlers.push(f.start("copy", []));
    // Settle in batches so the view stays under its own in-flight limit.
    if (f.calls.size === MAX_IN_FLIGHT_EDIT_CALLS) {
      expect(settleAll()).toBe(true);
    }
  }
  expect(settleAll()).toBe(true);
  expect(overLimit.at(-1)).toBe(true);
  expect(f.abandoned).toHaveLength(room + 2);
  expect(abandonedCompletionCount()).toBeGreaterThan(MAX_ABANDONED_COMPLETIONS);
  expect(f.calls.isBusy()).toBe(true);
  // Native releasing handlers lets the next prune reclaim them and clears the busy state.
  for (const handler of handlers) {
    handler.refs = 1;
  }
  f.calls.prune();
  expect(abandonedCompletionCount()).toBeLessThanOrEqual(
    MAX_ABANDONED_COMPLETIONS,
  );
  expect(f.calls.isBusy()).toBe(false);
});

test("a view with the maximum number of tracked calls is busy until some are released", () => {
  const f = fixture();
  const handlers: FakeHandler[] = [];
  for (let index = 0; index < MAX_IN_FLIGHT_EDIT_CALLS - 1; index++) {
    handlers.push(f.start("copy", []));
  }
  expect(f.calls.isBusy()).toBe(false);
  const last = f.start("copy", []);
  expect(f.calls.isBusy()).toBe(true);
  last.refs = 1;
  f.calls.prune();
  expect(f.calls.isBusy()).toBe(false);
});

test("an abandoned handler is reclaimed once native has released it", () => {
  const f = fixture();
  const handler = f.start("cut", []);
  f.settle(EDIT_COMPLETION_GRACE_MS + 1);
  const held = abandonedCompletionCount();
  f.calls.prune();
  expect(f.reclaimed).not.toContain(handler);
  handler.refs = 1;
  f.calls.prune();
  expect(f.reclaimed).toContain(handler);
  expect(abandonedCompletionCount()).toBe(held - 1);
  // A reclaimed handler is not released a second time.
  f.calls.prune();
  expect(f.reclaimed.filter((entry) => entry === handler)).toHaveLength(1);
});

test("the number of tracked calls is observable for the in-flight limit", () => {
  const f = fixture();
  const first = f.start("copy", []);
  f.start("cut", []);
  expect(f.calls.size).toBe(2);
  first.refs = 1;
  f.calls.prune();
  expect(f.calls.size).toBe(1);
});

test("a refused start keeps its handler for a later release instead of disposing it", () => {
  const f = fixture();
  const orphan: FakeHandler = {
    refs: 1,
    invoke() {},
  };
  expect(() =>
    f.calls.start(
      "paste",
      () => {
        throw Object.assign(new Error("refused"), {
          completion: orphan,
        });
      },
      {
        prune: false,
      },
    ),
  ).toThrow("refused");
  // Nothing is disposed inside the start, which may be a COM callback.
  expect(f.disposed).toEqual([]);
  expect(f.calls.handlers()).toEqual([
    orphan,
  ]);
  f.calls.prune();
  expect(f.disposed).toEqual([
    orphan,
  ]);
});

test("a refused start without a handler leaves nothing tracked", () => {
  const f = fixture();
  expect(() =>
    f.calls.start("copy", () => {
      throw new Error("refused");
    }),
  ).toThrow("refused");
  expect(f.calls.size).toBe(0);
});
