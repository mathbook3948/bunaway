import { expect, test } from "bun:test";
import type { WindowProcessFailureEvent } from "@bunaway/plugin-api/native";
import {
  isUnresponsiveFailure,
  planProcessFailure,
  processFailureKind,
  UnresponsiveEpisode,
} from "#native/windows/bun/process-failure";
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
      kind: "renderer-unresponsive",
      recovery: "none",
    }).success,
  ).toBe(true);
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

test("repeated unresponsive reports of one freeze count once and a pause starts a new freeze", () => {
  const episode = new UnresponsiveEpisode();
  expect(episode.begins(1_000)).toBe(true);
  // WebView2 repeats the report every few seconds while the freeze lasts.
  expect(episode.begins(16_000)).toBe(false);
  expect(episode.begins(31_000)).toBe(false);
  expect(episode.begins(150_000)).toBe(true);
  expect(episode.begins(160_000)).toBe(false);
  // A reload, a navigation or another failure ends the freeze, so a freeze right after it is reported.
  episode.reset();
  expect(episode.begins(165_000)).toBe(true);
});

test("a frozen renderer keeps its page and is reported once; an exited renderer or browser ends it", () => {
  const episode = new UnresponsiveEpisode();
  const frozen = planProcessFailure(2, false, episode, 1_000);
  expect(frozen).toEqual({
    log: true,
    report: "none",
    revokeSession: false,
    action: "none",
  });
  // A repeated report of the same freeze is neither logged nor forwarded.
  expect(planProcessFailure(2, false, episode, 16_000)).toEqual({
    log: false,
    report: undefined,
    revokeSession: false,
    action: "none",
  });
  // A closing view reports nothing even for a new freeze.
  expect(planProcessFailure(2, true, new UnresponsiveEpisode(), 0).report).toBe(
    undefined,
  );
  expect(planProcessFailure(1, false, episode, 20_000)).toEqual({
    log: true,
    report: "reload",
    revokeSession: true,
    action: "reload",
  });
  // The reload ended the freeze, so a freeze right after it is reported again.
  expect(planProcessFailure(2, false, episode, 21_000).report).toBe("none");
  expect(planProcessFailure(0, false, episode, 22_000)).toEqual({
    log: true,
    report: "close",
    revokeSession: true,
    action: "close-window",
  });
  expect(planProcessFailure(1, true, episode, 23_000).report).toBe(undefined);
});

test("only the unresponsive kind leaves the page running", () => {
  const kept = [
    ...Array(11).keys(),
  ].filter((kind) => isUnresponsiveFailure(kind));
  expect(kept).toEqual([
    2,
  ]);
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
