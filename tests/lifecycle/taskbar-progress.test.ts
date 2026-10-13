import { expect, test } from "bun:test";
import {
  type TaskbarProgress,
  TaskbarProgressController,
} from "#native/windows/bun/taskbar-progress";

test("taskbar readiness, shell recreation and reused HWNDs preserve independent window lifetimes", () => {
  const calls: {
    window: bigint;
    progress: TaskbarProgress;
  }[] = [];
  let fail = false;
  const controller = new TaskbarProgressController((window, progress) => {
    if (fail) {
      throw new Error("Native progress failure");
    }
    calls.push({
      window,
      progress,
    });
  });
  const progress = {
    state: "normal",
    value: 0.25,
  } as const;
  expect(() => controller.set(1n, progress)).toThrow(
    "taskbar button is not ready",
  );
  expect(calls).toEqual([]);
  controller.buttonCreated(1n);
  controller.buttonCreated(2n);
  controller.set(1n, progress);
  controller.set(2n, {
    state: "paused",
    value: 0.5,
  });
  controller.buttonCreated(1n);
  expect(calls).toEqual([
    {
      window: 1n,
      progress,
    },
    {
      window: 2n,
      progress: {
        state: "paused",
        value: 0.5,
      },
    },
    {
      window: 1n,
      progress,
    },
  ]);
  fail = true;
  expect(() =>
    controller.set(1n, {
      state: "none",
    }),
  ).toThrow("Native progress failure");
  expect(() => controller.buttonCreated(1n)).toThrow("Native progress failure");
  fail = false;
  controller.buttonCreated(1n);
  expect(calls.at(-1)).toEqual({
    window: 1n,
    progress,
  });
  controller.set(1n, {
    state: "none",
  });
  controller.buttonCreated(1n);
  expect(calls.at(-1)).toEqual({
    window: 1n,
    progress: {
      state: "none",
    },
  });
  controller.forget(1n);
  controller.forget(1n);
  expect(() => controller.set(1n, progress)).toThrow(
    "taskbar button is not ready",
  );
  const before = calls.length;
  controller.buttonCreated(1n);
  expect(calls).toHaveLength(before);
  controller.buttonCreated(2n);
  expect(calls.at(-1)).toEqual({
    window: 2n,
    progress: {
      state: "paused",
      value: 0.5,
    },
  });
});
