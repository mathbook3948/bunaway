import { expect, test } from "bun:test";
import type { WindowProcessFailureEvent } from "@bunaway/plugin-api/native";
import { processFailureKind } from "#native/windows/bun/process-failure";
import { windowDefinitions } from "#plugins/windows/src/contract";
import { ProcessFailureFeed } from "#plugins/windows/src/platforms/lifecycle-feed";

function source() {
  const listeners = new Set<(event: WindowProcessFailureEvent) => void>();
  return {
    subscribe(listener: (event: WindowProcessFailureEvent) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(event: WindowProcessFailureEvent) {
      for (const listener of listeners) {
        listener(event);
      }
    },
    listeners,
  };
}

const failure: WindowProcessFailureEvent = {
  windowId: "w1",
  viewId: "main",
  kind: "renderer-exited",
  recovery: "reload",
};

test("each COREWEBVIEW2_PROCESS_FAILED_KIND value has a stable name", () => {
  expect(
    [
      0,
      1,
      2,
      3,
      4,
      5,
      6,
      7,
      8,
      9,
    ].map(processFailureKind),
  ).toEqual([
    "browser-exited",
    "renderer-exited",
    "renderer-unresponsive",
    "frame-renderer-exited",
    "utility-exited",
    "sandbox-helper-exited",
    "gpu-exited",
    "plugin-exited",
    "plugin-broker-exited",
    "unknown-exited",
  ]);
});

test("a value the host does not know reports unknown-exited", () => {
  expect(processFailureKind(10)).toBe("unknown-exited");
  expect(processFailureKind(-1)).toBe("unknown-exited");
});

test("every mapped kind satisfies the operation output schema", () => {
  const output = windowDefinitions.waitForProcessFailure.output;
  for (let kind = 0; kind <= 10; kind++) {
    expect(
      output.safeParse({
        sequence: 1,
        windowId: "w1",
        viewId: "main",
        kind: processFailureKind(kind),
        recovery: "reload",
      }).success,
    ).toBe(true);
  }
  expect(
    output.safeParse({
      sequence: 1,
      windowId: "w1",
      viewId: "main",
      kind: "renderer-exited",
      recovery: "restart",
    }).success,
  ).toBe(false);
});

test("a platform without process failure notification reports UNSUPPORTED", async () => {
  const feed = new ProcessFailureFeed(undefined);
  await expect(feed.wait(undefined)).rejects.toMatchObject({
    code: "UNSUPPORTED",
  });
});

test("failures are numbered in order and a cursor resumes after the last one seen", async () => {
  const failures = source();
  const feed = new ProcessFailureFeed(failures.subscribe);
  const next = feed.wait(undefined);
  failures.emit(failure);
  expect(await next).toEqual({
    ...failure,
    sequence: 1,
  });
  failures.emit({
    ...failure,
    kind: "browser-exited",
    recovery: "close",
  });
  expect(await feed.wait(1)).toMatchObject({
    sequence: 2,
    kind: "browser-exited",
    recovery: "close",
  });
});

test("disposing the feed removes the host listener", () => {
  const failures = source();
  const feed = new ProcessFailureFeed(failures.subscribe);
  expect(failures.listeners.size).toBe(1);
  feed.dispose();
  expect(failures.listeners.size).toBe(0);
});
