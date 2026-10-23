import { expect, test } from "bun:test";
import type { WindowLifecycleEvent } from "@bunaway/plugin-api/native";
import {
  LifecycleFeed,
  MAX_LIFECYCLE_WAITERS,
} from "#plugins/windows/src/platforms/lifecycle-feed";

/** The retained history size the contract documents. */
const RETAINED_PHASES = 32;

function source() {
  const listeners = new Set<(event: WindowLifecycleEvent) => void>();
  return {
    subscribe(listener: (event: WindowLifecycleEvent) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(windowId: string, phase: WindowLifecycleEvent["phase"] = "created") {
      for (const listener of listeners) {
        listener({
          windowId,
          viewId: "main",
          phase,
        });
      }
    },
    listeners,
  };
}

test("a platform without lifecycle notification reports UNSUPPORTED", async () => {
  const feed = new LifecycleFeed(undefined);
  await expect(feed.wait(undefined)).rejects.toMatchObject({
    code: "UNSUPPORTED",
  });
});

test("waiting without a cursor resolves with the next phase and numbers phases in order", async () => {
  const phases = source();
  const feed = new LifecycleFeed(phases.subscribe);
  const next = feed.wait(undefined);
  phases.emit("w1");
  expect(await next).toEqual({
    sequence: 1,
    windowId: "w1",
    viewId: "main",
    phase: "created",
  });
  const second = feed.wait(undefined);
  phases.emit("w1", "ready");
  expect(await second).toMatchObject({
    sequence: 2,
    phase: "ready",
  });
});

test("a cursor resumes with the first retained phase after it, and after:0 reads from the start", async () => {
  const phases = source();
  const feed = new LifecycleFeed(phases.subscribe);
  phases.emit("w1", "created");
  phases.emit("w1", "ready");
  phases.emit("w1", "closed");
  expect(await feed.wait(0)).toMatchObject({
    sequence: 1,
    phase: "created",
  });
  expect(await feed.wait(1)).toMatchObject({
    sequence: 2,
    phase: "ready",
  });
  expect(await feed.wait(2)).toMatchObject({
    sequence: 3,
    phase: "closed",
  });
  const pending = feed.wait(3);
  phases.emit("w1", "destroyed");
  expect(await pending).toMatchObject({
    sequence: 4,
    phase: "destroyed",
  });
});

test("only the most recent phases are retained, so an older cursor jumps ahead", async () => {
  const phases = source();
  const feed = new LifecycleFeed(phases.subscribe);
  const total = RETAINED_PHASES + 8;
  for (let index = 0; index < total; index++) {
    phases.emit(`w${index}`);
  }
  expect(await feed.wait(0)).toMatchObject({
    sequence: total - RETAINED_PHASES + 1,
  });
});

test("waiters beyond the limit are BUSY and an aborted or disposed wait is CANCELLED", async () => {
  const phases = source();
  const feed = new LifecycleFeed(phases.subscribe);
  const controller = new AbortController();
  const waiting = Array.from(
    {
      length: MAX_LIFECYCLE_WAITERS,
    },
    () => feed.wait(undefined, controller.signal),
  );
  await expect(feed.wait(undefined)).rejects.toMatchObject({
    code: "BUSY",
  });
  controller.abort();
  for (const wait of waiting) {
    await expect(wait).rejects.toMatchObject({
      code: "CANCELLED",
    });
  }
  const pending = feed.wait(undefined);
  feed.dispose();
  await expect(pending).rejects.toMatchObject({
    code: "CANCELLED",
  });
  expect(phases.listeners.size).toBe(0);
});
