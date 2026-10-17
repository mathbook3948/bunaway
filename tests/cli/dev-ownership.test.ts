import { expect, test } from "bun:test";
import type { BuiltPackage } from "#cli/build";
import type { Project } from "#cli/config";
import { DevApp, type RunningDevApp } from "#cli/dev-app";
import { DevFrontend } from "#cli/dev-frontend";
import { DevWatcher, type WatchProject } from "#cli/dev-watcher";

const project = {
  root: "/project",
  frameworkRoot: "/framework",
  appEntry: "/project/src-bunaway/app.ts",
  frontend: "/project/src",
  app: {
    appId: "test.app",
    title: "test",
  },
  policy: {
    version: 1,
    views: [],
    backend: {
      permissions: [],
    },
  },
  dev: {
    command: [
      "bun",
      "run",
      "web",
    ],
    url: "http://127.0.0.1:5173/",
    timeoutMs: 1000,
  },
} satisfies Project;
const built: BuiltPackage = {
  output: "/project/dist",
  package: "/project/dist/package",
  executable: "/project/dist/package/app",
  arguments: [],
};

/** Lets tests explicitly complete process exits without timers or native resources. */
function appProcess(calls: string[]) {
  const exit = Promise.withResolvers<number>();
  let exitCode: number | null = null;
  let relaunch: readonly string[] | undefined;
  const app: RunningDevApp = {
    process: {
      pid: 123,
      exited: exit.promise,
      get exitCode() {
        return exitCode;
      },
      kill() {
        calls.push("kill");
      },
    },
    connection: {
      close() {
        calls.push("channel-close");
      },
      async reload() {
        throw new Error("Unexpected reload in lifecycle test.");
      },
      get relaunch() {
        return relaunch;
      },
    },
  };
  return {
    app,
    /** Records the relaunch request the CLI would have received over IPC. */
    requestRelaunch(argv: readonly string[]) {
      relaunch = argv;
    },
    exit(code: number) {
      exitCode = code;
      exit.resolve(code);
    },
  };
}

/** A ready server whose stop and exit completions are independently controlled. */
function frontendProcess(calls: string[], name: string) {
  const exit = Promise.withResolvers<number>();
  const stopped = Promise.withResolvers<void>();
  return {
    server: {
      exited: exit.promise,
      stop() {
        calls.push(`stop-${name}`);
        return stopped.promise;
      },
    },
    exit: exit.resolve,
    stopped: stopped.resolve,
  };
}

test("frontend settings reuse their owner and replacement waits for the old port to release", async () => {
  const calls: string[] = [];
  const first = frontendProcess(calls, "first");
  const second = frontendProcess(calls, "second");
  let starts = 0;
  const failures: Error[] = [];
  const frontend = new DevFrontend(
    new AbortController().signal,
    (error) => failures.push(error),
    async () => {
      starts += 1;
      calls.push(`start-${starts}`);
      return starts === 1 ? first.server : second.server;
    },
  );
  await frontend.sync(project);
  await frontend.sync({
    ...project,
  });
  expect(starts).toBe(1);
  const replaced = frontend.sync({
    ...project,
    dev: {
      ...project.dev,
      url: "http://127.0.0.1:5174/",
    },
  });
  expect(calls).toEqual([
    "start-1",
    "stop-first",
  ]);
  first.exit(7);
  first.stopped();
  await replaced;
  expect(failures).toEqual([]);
  second.exit(9);
  await second.server.exited;
  expect(failures.map((error) => error.message)).toEqual([
    "Frontend development server exited (exit 9). Restart bunaway dev.",
  ]);
  const closing = frontend.close();
  expect(frontend.close()).toBe(closing);
  second.stopped();
  await closing;
  expect(calls).toEqual([
    "start-1",
    "stop-first",
    "start-2",
    "stop-second",
  ]);
});

test("frontend startup failure leaves no adopted server and permits a later retry", async () => {
  const failure = new Error("server process startup failed");
  const calls: string[] = [];
  const ready = frontendProcess(calls, "ready");
  let attempts = 0;
  const frontend = new DevFrontend(
    new AbortController().signal,
    (error) => {
      throw error;
    },
    async () => {
      attempts += 1;
      if (attempts === 1) {
        throw failure;
      }
      return ready.server;
    },
  );
  await expect(frontend.sync(project)).rejects.toBe(failure);
  await frontend.sync(project);
  expect(attempts).toBe(2);
  ready.stopped();
  await frontend.close();
  ready.exit(0);
  await ready.server.exited;
  expect(calls).toEqual([
    "stop-ready",
  ]);
});

test("cancellation reclaims a frontend whose startup finishes late", async () => {
  const calls: string[] = [];
  const ready = frontendProcess(calls, "cancelled");
  const started = Promise.withResolvers<typeof ready.server>();
  const entered = Promise.withResolvers<void>();
  const abort = new AbortController();
  const failures: Error[] = [];
  const frontend = new DevFrontend(
    abort.signal,
    (error) => failures.push(error),
    () => {
      entered.resolve();
      return started.promise;
    },
  );
  const pending = frontend.sync(project);
  await entered.promise;
  abort.abort();
  started.resolve(ready.server);
  ready.stopped();
  await expect(pending).rejects.toThrow();
  await frontend.close();
  ready.exit(7);
  await ready.server.exited;
  expect(calls).toEqual([
    "stop-cancelled",
  ]);
  expect(failures).toEqual([]);
});

test("app startup failure leaves ownership empty and a later save can launch", async () => {
  const calls: string[] = [];
  const current = appProcess(calls);
  const failure = new Error("app process startup failed");
  let attempts = 0;
  const exits: number[] = [];
  const owner = new DevApp(
    new AbortController().signal,
    (code) => exits.push(code),
    undefined,
    undefined,
    {
      async launch() {
        attempts += 1;
        if (attempts === 1) {
          throw failure;
        }
        return current.app;
      },
      async stop(app) {
        calls.push("stop");
        await app.process.exited;
      },
    },
  );
  await expect(owner.start(project, built, () => true)).rejects.toBe(failure);
  expect(owner.running).toBe(false);
  await owner.stop();
  await owner.start(project, built, () => true);
  expect(owner.running).toBe(true);
  const closing = owner.stop();
  expect(owner.stop()).toBe(closing);
  expect(calls).toEqual([
    "channel-close",
    "stop",
  ]);
  current.exit(9);
  await closing;
  expect(exits).toEqual([]);
  await owner.stop();
  expect(calls).toEqual([
    "channel-close",
    "stop",
  ]);
});

test.each([
  "cancelled",
  "stale",
])(
  "%s app startup reclaims the late process before completing",
  async (reason) => {
    const calls: string[] = [];
    const current = appProcess(calls);
    const launch = Promise.withResolvers<RunningDevApp>();
    const abort = new AbortController();
    const exits: number[] = [];
    let isCurrent = true;
    const owner = new DevApp(
      abort.signal,
      (code) => exits.push(code),
      undefined,
      undefined,
      {
        launch: () => launch.promise,
        async stop(app) {
          calls.push("stop");
          await app.process.exited;
        },
      },
    );
    const pending = owner.start(project, built, () => isCurrent);
    if (reason === "cancelled") {
      abort.abort();
    } else {
      isCurrent = false;
    }
    launch.resolve(current.app);
    current.exit(7);
    await pending;
    expect(owner.running).toBe(false);
    expect(calls).toEqual([
      "channel-close",
      "stop",
    ]);
    expect(exits).toEqual([]);
  },
);

test("only the currently owned app reports unexpected exit", async () => {
  const calls: string[] = [];
  const first = appProcess(calls);
  const second = appProcess(calls);
  let launches = 0;
  const exits: number[] = [];
  const owner = new DevApp(
    new AbortController().signal,
    (code) => exits.push(code),
    undefined,
    undefined,
    {
      async launch() {
        launches += 1;
        return launches === 1 ? first.app : second.app;
      },
      async stop(app) {
        await app.process.exited;
      },
    },
  );
  await owner.start(project, built, () => true);
  const closing = owner.stop();
  first.exit(7);
  await closing;
  await owner.start(project, built, () => true);
  second.exit(3);
  await second.app.process.exited;
  expect(exits).toEqual([
    3,
  ]);
  await owner.stop();
});

test("watcher invalidates pending changes synchronously and follows recovery and project updates", () => {
  const abort = new AbortController();
  let currentProject: Project = project;
  let recovering = false;
  let closed = 0;
  const changes: string[][] = [];
  let notify: (name: string | null) => void = () => {
    throw new Error("Watcher not opened.");
  };
  const open: WatchProject = (root, changed) => {
    expect(root).toBe(project.root);
    notify = changed;
    return {
      close() {
        closed += 1;
      },
    };
  };
  const sources = new DevWatcher(
    {
      project: () => currentProject,
      recovering: () => recovering,
    },
    abort.signal,
    (delayMs) => {
      expect(delayMs).toBe(150);
      changes.push([
        ...sources.pendingChanges,
      ]);
    },
    open,
  );
  sources.start();
  sources.start();
  notify(null);
  notify("src/main.ts");
  notify(".git/index");
  notify("src-bunaway/app.ts");
  notify("src-bunaway/app.ts");
  notify("src-bunaway/bunaway.json");
  expect(changes).toEqual([
    [
      "src-bunaway/app.ts",
    ],
    [
      "src-bunaway/app.ts",
    ],
    [
      "src-bunaway/app.ts",
      "src-bunaway/bunaway.json",
    ],
  ]);
  sources.clear();
  recovering = true;
  notify("shared/missing.ts");
  expect(sources.pendingChanges).toEqual([
    "shared/missing.ts",
  ]);
  recovering = false;
  currentProject = {
    ...project,
    backendDependencies: [
      "shared/missing.ts",
    ],
  };
  sources.clear();
  notify("shared/missing.ts");
  abort.abort();
  notify("src-bunaway/app.ts");
  expect(sources.pendingChanges).toEqual([
    "shared/missing.ts",
  ]);
  sources.close();
  sources.close();
  sources.start();
  notify("src-bunaway/late.ts");
  expect(closed).toBe(1);
  expect(sources.pendingChanges).toEqual([
    "shared/missing.ts",
  ]);
});

test("development cancellation keeps the ready frontend available until its owner closes", async () => {
  const calls: string[] = [];
  const ready = frontendProcess(calls, "ready");
  const abort = new AbortController();
  const frontend = new DevFrontend(
    abort.signal,
    (error) => {
      throw error;
    },
    async (_config, _root, signal) => {
      signal.addEventListener(
        "abort",
        () => {
          calls.push("server-aborted");
        },
        {
          once: true,
        },
      );
      return ready.server;
    },
  );
  await frontend.sync(project);
  abort.abort();
  expect(calls).toEqual([]);
  const closing = frontend.close();
  expect(frontend.close()).toBe(closing);
  expect(calls).toEqual([
    "stop-ready",
  ]);
  ready.stopped();
  ready.exit(0);
  await closing;
});

test("development cancellation reaches an in-flight frontend startup", async () => {
  const entered = Promise.withResolvers<void>();
  const abort = new AbortController();
  const reason = new Error("Development cancelled");
  let observed = false;
  const frontend = new DevFrontend(
    abort.signal,
    (error) => {
      throw error;
    },
    (_config, _root, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            observed = true;
            reject(signal.reason);
          },
          {
            once: true,
          },
        );
        entered.resolve();
      }),
  );
  const starting = frontend.sync(project);
  await entered.promise;
  abort.abort(reason);
  await expect(starting).rejects.toBe(reason);
  expect(observed).toBe(true);
  await frontend.close();
});

test("an exit after a relaunch request restarts with its arguments once, whatever the exit code", async () => {
  const calls: string[] = [];
  const processes = [
    appProcess(calls),
    appProcess(calls),
    appProcess(calls),
  ];
  const launchedWith: (readonly string[])[] = [];
  const exits: number[] = [];
  const owner = new DevApp(
    new AbortController().signal,
    (code) => exits.push(code),
    undefined,
    undefined,
    {
      async launch(_project, _built, _isCurrent, appArguments) {
        launchedWith.push(appArguments);
        return processes[launchedWith.length - 1]?.app;
      },
      async stop(app) {
        await app.process.exited;
      },
    },
  );
  await owner.start(project, built, () => true);
  processes[0]?.requestRelaunch([
    "--again",
    "x y",
  ]);
  // The requested exit code, even a failing one, does not end the session.
  processes[0]?.exit(5);
  // The owner restarts the last built package itself, with the requested arguments...
  for (
    let waited = 0;
    !(launchedWith.length >= 2 && owner.running) && waited < 100;
    waited++
  ) {
    await Bun.sleep(1);
  }
  expect(exits).toEqual([]);
  expect(owner.running).toBe(true);
  expect(launchedWith).toEqual([
    [],
    [
      "--again",
      "x y",
    ],
  ]);
  // ...and a later source-change restart does not repeat them.
  const restarting = owner.stop();
  processes[1]?.exit(0);
  await restarting;
  await owner.start(project, built, () => true);
  expect(launchedWith[2]).toEqual([]);
  const closing = owner.stop();
  processes[2]?.exit(0);
  await closing;
});

test("an exit without a relaunch request reports the exit and does not restart", async () => {
  const process1 = appProcess([]);
  const exits: number[] = [];
  let launches = 0;
  const owner = new DevApp(
    new AbortController().signal,
    (code) => exits.push(code),
    undefined,
    undefined,
    {
      async launch() {
        launches += 1;
        return process1.app;
      },
      async stop(app) {
        await app.process.exited;
      },
    },
  );
  await owner.start(project, built, () => true);
  process1.exit(0);
  await process1.app.process.exited;
  expect(exits).toEqual([
    0,
  ]);
  expect(launches).toBe(1);
});

test("a failed relaunch is reported, keeps the session and does not leak its arguments into the next restart", async () => {
  const first = appProcess([]);
  const second = appProcess([]);
  const launchedWith: (readonly string[])[] = [];
  const exits: number[] = [];
  const owner = new DevApp(
    new AbortController().signal,
    (code) => exits.push(code),
    undefined,
    undefined,
    {
      async launch(_project, _built, _isCurrent, appArguments) {
        launchedWith.push(appArguments);
        if (launchedWith.length === 2) {
          throw new Error("spawn failed");
        }
        return launchedWith.length === 1 ? first.app : second.app;
      },
      async stop(app) {
        await app.process.exited;
      },
    },
  );
  const errors: unknown[][] = [];
  const consoleError = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args);
  };
  try {
    await owner.start(project, built, () => true);
    first.requestRelaunch([
      "--again",
    ]);
    first.exit(0);
    for (let waited = 0; errors.length === 0 && waited < 100; waited++) {
      await Bun.sleep(1);
    }
  } finally {
    console.error = consoleError;
  }
  expect(String(errors[0]?.[0])).toContain("Relaunch failed");
  expect(exits).toEqual([]);
  expect(owner.running).toBe(false);
  // The next normal start does not receive the failed relaunch's arguments.
  await owner.start(project, built, () => true);
  expect(launchedWith).toEqual([
    [],
    [
      "--again",
    ],
    [],
  ]);
  const closing = owner.stop();
  second.exit(0);
  await closing;
});

test("a restart from the controller supersedes a relaunch still launching, leaving one tracked host", async () => {
  const processes = [
    appProcess([]),
    appProcess([]),
    appProcess([]),
  ];
  const relaunchLaunch = Promise.withResolvers<void>();
  const stopped: unknown[] = [];
  let launches = 0;
  const owner = new DevApp(
    new AbortController().signal,
    () => {},
    undefined,
    undefined,
    {
      async launch() {
        launches += 1;
        const index = launches - 1;
        if (index === 1) {
          // The relaunch's host is slow to start.
          await relaunchLaunch.promise;
        }
        return processes[index]?.app;
      },
      async stop(app) {
        stopped.push(app.process);
        await app.process.exited;
      },
    },
  );
  await owner.start(project, built, () => true);
  processes[0]?.requestRelaunch([
    "--again",
  ]);
  processes[0]?.exit(0);
  for (let waited = 0; launches < 2 && waited < 100; waited++) {
    await Bun.sleep(1);
  }
  expect(launches).toBe(2);
  // A source change restarts through the controller while the relaunch's launch is pending.
  await owner.stop();
  await owner.start(project, built, () => true);
  expect(launches).toBe(3);
  // The relaunch's host then appears: it is released instead of overwriting the tracked one.
  relaunchLaunch.resolve();
  processes[1]?.exit(0);
  for (
    let waited = 0;
    !stopped.includes(processes[1]?.app.process) && waited < 100;
    waited++
  ) {
    await Bun.sleep(1);
  }
  expect(stopped).toContain(processes[1]?.app.process);
  expect(owner.running).toBe(true);
  // Stopping the owner stops the tracked host, the third one.
  const closing = owner.stop();
  processes[2]?.exit(0);
  await closing;
  expect(stopped).toContain(processes[2]?.app.process);
});
