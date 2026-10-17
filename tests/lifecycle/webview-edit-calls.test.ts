import { expect, test } from "bun:test";
import {
  abandonedCompletionCount,
  EDIT_COMPLETION_GRACE_MS,
  EditCommandCalls,
  MAX_ABANDONED_COMPLETIONS,
} from "#native/windows/bun/webview-edit-calls";

/** Stand-in for a COM handler: `refs` is 2 while native holds it, 1 once released. */
type FakeHandler = {
  refs: number;
  invoke(): void;
};

function fixture() {
  const disposed: FakeHandler[] = [];
  const abandoned: FakeHandler[] = [];
  const reported: string[] = [];
  const calls = new EditCommandCalls<FakeHandler>({
    dispose: (handlers) => disposed.push(...handlers),
    abandon: (handlers) => abandoned.push(...handlers),
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

test("abandonment is bounded", () => {
  const f = fixture();
  const room = MAX_ABANDONED_COMPLETIONS - abandonedCompletionCount();
  for (let index = 0; index < room; index++) {
    f.start("copy", []);
  }
  expect(f.settle(EDIT_COMPLETION_GRACE_MS + 1)).toBe(true);
  f.start("copy", []);
  expect(() => f.settle(EDIT_COMPLETION_GRACE_MS + 1)).toThrow(
    "Too many abandoned",
  );
});
