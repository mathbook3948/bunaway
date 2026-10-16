import { expect, test } from "bun:test";
import type { ShutdownReason } from "@bunaway/core";
import { runBackendShutdown } from "#native/macos/bun/backend-shutdown";
import { DesktopLifecycle } from "../../native/windows/bun/desktop.ts";

/** Real lifecycle with recording hooks; the order of the returned steps is the contract. */
function harness(options: { orderly: boolean; hookDeadlineMs?: number }) {
  const steps: string[] = [];
  const nativeStopped = Promise.withResolvers<void>();
  const desktop = new DesktopLifecycle(
    {
      onWillQuit: (reason) => {
        steps.push(`onWillQuit:${reason}`);
      },
      onQuit: (reason) => {
        steps.push(`onQuit:${reason}`);
      },
    },
    async () => {},
    () => {},
    () => {},
    options.hookDeadlineMs,
  );
  const run = (reason?: ShutdownReason) => {
    if (reason) {
      desktop.commitShutdown(reason);
    }
    return runBackendShutdown({
      desktop,
      orderly: options.orderly,
      stopCore: async () => {
        steps.push("stopCore");
      },
      reportCleaned: async () => {
        steps.push("cleaned");
      },
      nativeStopped: nativeStopped.promise,
    });
  };
  return {
    steps,
    nativeStopped,
    run,
  };
}

test("an orderly shutdown runs onWillQuit before Core stops and onQuit after native teardown", async () => {
  const { steps, nativeStopped, run } = harness({
    orderly: true,
  });
  const finished = run("quit-command");
  await Bun.sleep(20);
  // Cleanup is reported so the main thread tears down, but onQuit waits for it.
  expect(steps).toEqual([
    "onWillQuit:quit-command",
    "stopCore",
    "cleaned",
  ]);
  nativeStopped.resolve();
  await finished;
  expect(steps).toEqual([
    "onWillQuit:quit-command",
    "stopCore",
    "cleaned",
    "onQuit:quit-command",
  ]);
});

test("a host failure skips the app's hooks and does not wait for native teardown", async () => {
  const { steps, run } = harness({
    orderly: false,
  });
  // No cause was committed, and nativeStopped never settles.
  await run();
  expect(steps).toEqual([
    "stopCore",
    "cleaned",
  ]);
});

test("a session end wins over a pending veto and still runs both hooks once", async () => {
  const steps: string[] = [];
  let vetoed: (allowed: boolean) => void = () => {};
  const desktop = new DesktopLifecycle(
    {
      beforeQuit: () =>
        new Promise<boolean>((resolve) => {
          vetoed = resolve;
        }),
      onWillQuit: (reason) => {
        steps.push(`onWillQuit:${reason}`);
      },
      onQuit: (reason) => {
        steps.push(`onQuit:${reason}`);
      },
    },
    async () => {},
    () => steps.push("stop"),
    () => {},
  );
  const quit = desktop.quit("quit-command");
  // Let beforeQuit start so there is a pending decision to ignore.
  await Bun.sleep(0);
  desktop.commitShutdown("session-end");
  vetoed(false);
  // The veto no longer matters: the quit reports as allowed and does not begin another stop.
  expect(await quit).toBe(true);
  await runBackendShutdown({
    desktop,
    orderly: true,
    stopCore: async () => {
      steps.push("stopCore");
    },
    reportCleaned: async () => {},
    nativeStopped: Promise.resolve(),
  });
  expect(steps).toEqual([
    "onWillQuit:session-end",
    "stopCore",
    "onQuit:session-end",
  ]);
});

test("a hook that overruns its deadline does not hold the shutdown", async () => {
  const steps: string[] = [];
  const desktop = new DesktopLifecycle(
    {
      onWillQuit: () => new Promise<void>(() => {}),
      onQuit: () => new Promise<void>(() => {}),
    },
    async () => {},
    () => {},
    (error) => steps.push(`report:${(error as Error).message}`),
    20,
  );
  desktop.commitShutdown("interrupted");
  await runBackendShutdown({
    desktop,
    orderly: true,
    stopCore: async () => {
      steps.push("stopCore");
    },
    reportCleaned: async () => {},
    nativeStopped: Promise.resolve(),
  });
  expect(steps).toEqual([
    "report:desktop.onWillQuit did not finish in 20 ms",
    "stopCore",
    "report:desktop.onQuit did not finish in 20 ms",
  ]);
});

test("an app that never loaded has no hooks to run", async () => {
  const steps: string[] = [];
  await runBackendShutdown({
    desktop: undefined,
    orderly: true,
    stopCore: async () => {
      steps.push("stopCore");
    },
    reportCleaned: async () => {
      steps.push("cleaned");
    },
    nativeStopped: Promise.resolve(),
  });
  expect(steps).toEqual([
    "stopCore",
    "cleaned",
  ]);
});
