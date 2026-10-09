import { expect, test } from "bun:test";
import { RestartController } from "../../packages/cli/src/dev.ts";

test("a debounced UI save during reload invalidates it immediately and rebuilds the UI", async () => {
  const entered = Promise.withResolvers<void>();
  const response = Promise.withResolvers<void>();
  const changedFiles = new Set<string>();
  let active = false;
  let reloadIsCurrent = () => true;
  let builds = 0;
  const controller = new RestartController({
    async stop() {
      active = false;
    },
    async build() {
      builds += 1;
      return builds;
    },
    async start() {
      active = true;
      changedFiles.clear();
    },
    error(error) {
      throw error;
    },
    async reload(isCurrent) {
      if (!active || changedFiles.has("src/main.ts")) {
        return false;
      }
      reloadIsCurrent = isCurrent;
      entered.resolve();
      await response.promise;
      if (isCurrent()) {
        changedFiles.clear();
      }
      return true;
    },
  });
  try {
    await controller.change();
    changedFiles.add("src-bunaway/app.ts");
    const reload = controller.change();
    await entered.promise;
    changedFiles.add("src/main.ts");
    const saved = controller.change(20);
    expect(reloadIsCurrent()).toBe(false);
    response.resolve();
    await Promise.all([
      reload,
      saved,
    ]);
    expect(builds).toBe(2);
    expect(changedFiles.size).toBe(0);
  } finally {
    response.resolve();
    await controller.close();
  }
});

test("debounce resets on another save and close cancels its pending work", async () => {
  let builds = 0;
  const controller = new RestartController({
    async stop() {},
    async build() {
      builds += 1;
      return builds;
    },
    async start() {},
    error(error) {
      throw error;
    },
  });
  const first = controller.change(20);
  const latest = controller.change(20);
  await Bun.sleep(0);
  expect(builds).toBe(0);
  await Promise.all([
    first,
    latest,
  ]);
  expect(builds).toBe(1);
  const pending = controller.change(60000);
  await controller.close();
  await pending;
  expect(builds).toBe(1);
});

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
