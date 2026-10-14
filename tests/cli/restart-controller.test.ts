import { expect, test } from "bun:test";
import { RestartController } from "#cli/dev";
import type { RestartTimer } from "#cli/restart-controller";

/** Controls debounce deadlines without sleeping or depending on wall-clock scheduling. */
function restartClock() {
  let pending: (() => void) | undefined;
  const delays: number[] = [];
  const schedule: RestartTimer = (delayMs, ready) => {
    delays.push(delayMs);
    pending = ready;
    return () => {
      if (pending === ready) {
        pending = undefined;
      }
    };
  };
  return {
    schedule,
    delays,
    fire() {
      const ready = pending;
      pending = undefined;
      ready?.();
    },
    get pending() {
      return pending !== undefined;
    },
  };
}

test("a debounced UI save during reload invalidates it immediately and rebuilds the UI", async () => {
  const clock = restartClock();
  const entered = Promise.withResolvers<void>();
  const response = Promise.withResolvers<void>();
  const changedFiles = new Set<string>();
  let active = false;
  let reloadIsCurrent = () => true;
  let builds = 0;
  const controller = new RestartController(
    {
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
          // Only a reload that still owns the latest revision may consume these changes.
          changedFiles.clear();
        }
        return true;
      },
    },
    clock.schedule,
  );
  try {
    await controller.change();
    changedFiles.add("src-bunaway/app.ts");
    const reload = controller.change();
    await entered.promise;
    changedFiles.add("src/main.ts");
    const saved = controller.change(20);
    expect(reloadIsCurrent()).toBe(false);
    response.resolve();
    clock.fire();
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
  const clock = restartClock();
  let builds = 0;
  const controller = new RestartController(
    {
      async stop() {},
      async build() {
        builds += 1;
        return builds;
      },
      async start() {},
      error(error) {
        throw error;
      },
    },
    clock.schedule,
  );
  const first = controller.change(20);
  const latest = controller.change(20);
  expect(clock.delays).toEqual([
    20,
    20,
  ]);
  expect(clock.pending).toBe(true);
  expect(builds).toBe(0);
  clock.fire();
  await Promise.all([
    first,
    latest,
  ]);
  expect(builds).toBe(1);
  const pending = controller.change(60000);
  await controller.close();
  await pending;
  expect(clock.pending).toBe(false);
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
      // A completed candidate is applied only if no newer edit arrived while it waited.
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

test("rapid edits during teardown skip stale builds and launch only the latest revision", async () => {
  const entered = Promise.withResolvers<void>();
  const stopped = Promise.withResolvers<void>();
  const calls: string[] = [];
  let stops = 0;
  const controller = new RestartController({
    async stop() {
      stops += 1;
      if (stops === 1) {
        entered.resolve();
        await stopped.promise;
      }
    },
    async build() {
      calls.push("build");
      return "latest";
    },
    async start(value) {
      calls.push(value);
    },
    error(error) {
      throw error;
    },
  });
  const first = controller.change();
  await entered.promise;
  const edits = [
    controller.change(),
    controller.change(),
    controller.change(),
  ];
  stopped.resolve();
  await Promise.all([
    first,
    ...edits,
  ]);
  expect(calls).toEqual([
    "build",
    "latest",
  ]);
  await controller.close();
});

test("shutdown waits for an uncancellable build and discards its result", async () => {
  const entered = Promise.withResolvers<void>();
  const built = Promise.withResolvers<string>();
  const calls: string[] = [];
  const controller = new RestartController({
    async stop() {
      calls.push("stop");
    },
    async build() {
      entered.resolve();
      return built.promise;
    },
    async start() {
      calls.push("start");
    },
    error(error) {
      throw error;
    },
  });
  const running = controller.change();
  await entered.promise;
  const closing = controller.close();
  expect(controller.close()).toBe(closing);
  expect(calls).toEqual([
    "stop",
  ]);
  built.resolve("cancelled");
  await Promise.all([
    running,
    closing,
  ]);
  await controller.change();
  expect(calls).toEqual([
    "stop",
    "stop",
  ]);
});

test("startup failure is reported once and a later edit retries successfully", async () => {
  const failure = new Error("process startup failed");
  const errors: unknown[] = [];
  let attempts = 0;
  let started = false;
  const controller = new RestartController({
    async stop() {
      started = false;
    },
    async build() {
      return 1;
    },
    async start() {
      attempts += 1;
      if (attempts === 1) {
        throw failure;
      }
      started = true;
    },
    error(error) {
      errors.push(error);
    },
  });
  await controller.change();
  expect(errors).toEqual([
    failure,
  ]);
  expect(started).toBe(false);
  await controller.change();
  expect(started).toBe(true);
  expect(attempts).toBe(2);
  await controller.close();
});

test("edits and shutdown invalidate a revision while its launch is pending", async () => {
  const entered = Promise.withResolvers<void>();
  const verified = Promise.withResolvers<void>();
  let launches = 0;
  let current = () => true;
  const controller = new RestartController({
    async stop() {},
    async build() {
      return 1;
    },
    async start(_built, isCurrent) {
      current = isCurrent;
      entered.resolve();
      await verified.promise;
      if (isCurrent()) {
        launches += 1;
      }
    },
    error(error) {
      throw error;
    },
  });
  const running = controller.change();
  await entered.promise;
  const edit = controller.change();
  expect(current()).toBe(false);
  const closing = controller.close();
  verified.resolve();
  await Promise.all([
    running,
    edit,
    closing,
  ]);
  expect(launches).toBe(0);
});

test("an edit as a restart pass completes still runs a new pass", async () => {
  let starts = 0;
  const edited = Promise.withResolvers<Promise<void>>();
  const controller = new RestartController({
    async stop() {},
    async build() {
      return 1;
    },
    async start() {
      starts += 1;
      if (starts === 1) {
        // Deliver the edit after restart() resumes from start(), before a promise finalizer runs.
        queueMicrotask(() =>
          queueMicrotask(() => edited.resolve(controller.change())),
        );
      }
    },
    error(error) {
      throw error;
    },
  });
  await controller.change();
  await edited.promise;
  expect(starts).toBe(2);
  await controller.close();
});
