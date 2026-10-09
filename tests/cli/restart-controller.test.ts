import { expect, test } from "bun:test";
import { RestartController } from "../../packages/cli/src/dev.ts";

test("successful reload skips host teardown and reload failure keeps the running host", async () => {
  const calls: string[] = [];
  let active = false;
  let broken = false;
  const controller = new RestartController({
    async stop() {
      calls.push("stop");
      active = false;
    },
    async build() {
      calls.push("build");
      return 1;
    },
    async start() {
      calls.push("start");
      active = true;
    },
    error() {
      calls.push("error");
    },
    async reload() {
      if (!active) {
        return false;
      }
      if (broken) {
        throw new Error("Broken app source");
      }
      calls.push("reload");
      return true;
    },
  });
  await controller.change();
  await controller.change();
  broken = true;
  await controller.change();
  expect(calls).toEqual([
    "stop",
    "build",
    "start",
    "reload",
    "error",
  ]);
  expect(active).toBe(true);
  await controller.close();
  expect(active).toBe(false);
});

test("a stale reload candidate is discarded and close prevents a pending replacement", async () => {
  let release = () => {};
  let entered = () => {};
  let waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let active = false;
  let block = true;
  let applied = 0;
  const controller = new RestartController({
    async stop() {
      active = false;
    },
    async build() {
      return 1;
    },
    async start() {
      active = true;
    },
    error(error) {
      throw error;
    },
    async reload(isCurrent) {
      if (!active) {
        return false;
      }
      if (block) {
        block = false;
        entered();
        await waiting;
      }
      if (isCurrent()) {
        applied += 1;
      }
      return true;
    },
  });
  await controller.change();
  const first = controller.change();
  await started;
  const latest = controller.change();
  release();
  await Promise.all([
    first,
    latest,
  ]);
  expect(applied).toBe(1);
  waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  block = true;
  const pending = controller.change();
  await started;
  const closing = controller.close();
  release();
  await Promise.all([
    pending,
    closing,
  ]);
  await controller.change();
  expect(applied).toBe(1);
  expect(active).toBe(false);
});
