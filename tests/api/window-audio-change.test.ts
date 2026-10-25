import { expect, test } from "bun:test";
import type { WindowAudioChangeEvent } from "@bunaway/plugin-api/native";
import { AudioChanges } from "#native/windows/bun/audio-events";
import { windowDefinitions } from "#plugins/windows/src/contract";
import { AudioChangeFeed } from "#plugins/windows/src/platforms/lifecycle-feed";

function source() {
  const listeners = new Set<(event: WindowAudioChangeEvent) => void>();
  return {
    subscribe(listener: (event: WindowAudioChangeEvent) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(event: WindowAudioChangeEvent) {
      for (const listener of listeners) {
        listener(event);
      }
    },
    listeners,
  };
}

const change: WindowAudioChangeEvent = {
  windowId: "w1",
  viewId: "main",
  muted: true,
  playing: false,
};

function changes(
  states: {
    muted: boolean;
    playing: boolean;
  }[],
) {
  const published: {
    muted: boolean;
    playing: boolean;
  }[] = [];
  let current = {
    muted: false,
    playing: false,
  };
  const tracker = new AudioChanges(
    () => current,
    (state) => published.push(state),
  );
  return {
    published,
    run() {
      for (const state of states) {
        current = state;
        tracker.check();
      }
    },
  };
}

test("a state equal to the last one published is not published again", () => {
  const run = changes([
    {
      muted: false,
      playing: false,
    },
    {
      muted: true,
      playing: false,
    },
    {
      muted: true,
      playing: false,
    },
    {
      muted: true,
      playing: true,
    },
    {
      muted: false,
      playing: true,
    },
    {
      muted: false,
      playing: true,
    },
  ]);
  run.run();
  expect(run.published).toEqual([
    {
      muted: true,
      playing: false,
    },
    {
      muted: true,
      playing: true,
    },
    {
      muted: false,
      playing: true,
    },
  ]);
});

test("the result schema requires both states and rejects extra fields", () => {
  const output = windowDefinitions.waitForAudioChange.output;
  expect(
    output.safeParse({
      ...change,
      sequence: 1,
    }).success,
  ).toBe(true);
  expect(
    output.safeParse({
      sequence: 1,
      windowId: "w1",
      viewId: "main",
      muted: true,
    }).success,
  ).toBe(false);
  expect(
    output.safeParse({
      ...change,
      sequence: 1,
      volume: 1,
    }).success,
  ).toBe(false);
});

test("a platform without audio change notification reports UNSUPPORTED", async () => {
  const feed = new AudioChangeFeed(undefined);
  await expect(feed.wait(undefined)).rejects.toMatchObject({
    code: "UNSUPPORTED",
  });
});

test("changes are numbered in order and a cursor resumes after the last one seen", async () => {
  const audio = source();
  const feed = new AudioChangeFeed(audio.subscribe);
  const next = feed.wait(undefined);
  audio.emit(change);
  expect(await next).toEqual({
    ...change,
    sequence: 1,
  });
  audio.emit({
    ...change,
    muted: false,
    playing: true,
  });
  expect(await feed.wait(1)).toMatchObject({
    sequence: 2,
    muted: false,
    playing: true,
  });
});

test("disposing the feed removes the host listener", () => {
  const audio = source();
  const feed = new AudioChangeFeed(audio.subscribe);
  expect(audio.listeners.size).toBe(1);
  feed.dispose();
  expect(audio.listeners.size).toBe(0);
});
