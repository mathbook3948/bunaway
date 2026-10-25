import { expect, setDefaultTimeout, test } from "bun:test";
import { BunawayError, MSIX_STARTUP_TASK_ID } from "@bunaway/protocol";
import {
  disable,
  enable,
  getStatus,
} from "#plugins/autostart/src/platforms/windows";
import {
  openStartupTask,
  STARTUP_TASK_STATE,
  type StartupTaskApi,
  startupTaskStatus,
} from "#plugins/autostart/src/platforms/windows-startup-task";
import { deadline } from "../fixtures/deadlines.ts";

setDefaultTimeout(deadline("inProcess"));

/** A task whose state changes the way Windows reports it after RequestEnableAsync. */
function fakeTask(initial: number, afterRequest: number) {
  const calls: string[] = [];
  let state = initial;
  const task: StartupTaskApi = {
    state: () => state,
    requestEnable: () => {
      calls.push("requestEnable");
      state = afterRequest;
      return Promise.resolve(state);
    },
    disable: () => {
      calls.push("disable");
      state = STARTUP_TASK_STATE.disabled;
    },
  };
  return {
    calls,
    open: <T>(
      _signal: AbortSignal | undefined,
      use: (t: StartupTaskApi) => Promise<T>,
    ) => use(task),
  };
}

/** Adapter state for a process that has package identity. */
function packagedState(open: ReturnType<typeof fakeTask>["open"]) {
  return {
    app: {
      id: "com.example.app",
      launch: {
        mode: "packaged" as const,
        executablePath: "C:\\App\\app.exe",
        args: [],
      },
    },
    name: "bunaway.packaged.com.example.app",
    registry: {
      packaged: () => true,
    },
    startupTask: open,
  } as unknown as Parameters<typeof getStatus>[0];
}

test("every StartupTaskState maps onto the existing status fields", () => {
  const cases = [
    [
      STARTUP_TASK_STATE.disabled,
      false,
      "disabled",
    ],
    [
      STARTUP_TASK_STATE.disabledByUser,
      true,
      "disabled",
    ],
    [
      STARTUP_TASK_STATE.enabled,
      true,
      "enabled",
    ],
    [
      STARTUP_TASK_STATE.disabledByPolicy,
      false,
      "disabled",
    ],
    [
      STARTUP_TASK_STATE.enabledByPolicy,
      true,
      "enabled",
    ],
    [
      99,
      false,
      "unknown",
    ],
  ] as const;
  for (const [state, registered, startupState] of cases) {
    expect(startupTaskStatus(state)).toEqual({
      registrationName: MSIX_STARTUP_TASK_ID,
      registered,
      commandLine: null,
      executablePath: null,
      args: null,
      startupState,
      matchesCurrentLaunch: false,
    });
  }
});

test("enable requests the disabled task once and reports the resulting state", async () => {
  const task = fakeTask(
    STARTUP_TASK_STATE.disabled,
    STARTUP_TASK_STATE.enabled,
  );
  const state = packagedState(task.open);
  const status = await enable(state, {
    args: [],
    hidden: false,
  });
  expect(status.startupState).toBe("enabled");
  expect(task.calls).toEqual([
    "requestEnable",
  ]);
  // Repeating the request leaves an enabled task alone.
  await enable(state, {
    args: [],
    hidden: false,
  });
  expect(task.calls).toEqual([
    "requestEnable",
  ]);
});

test("enable keeps a task the user or policy disabled and reports it", async () => {
  for (const initial of [
    STARTUP_TASK_STATE.disabledByUser,
    STARTUP_TASK_STATE.disabledByPolicy,
  ]) {
    const task = fakeTask(initial, STARTUP_TASK_STATE.enabled);
    const status = await enable(packagedState(task.open), {
      args: [],
      hidden: false,
    });
    expect(status.startupState).toBe("disabled");
    expect(task.calls).toEqual([]);
  }
});

test("enable rejects arguments and hidden startup that a manifest task cannot carry", () => {
  const task = fakeTask(
    STARTUP_TASK_STATE.disabled,
    STARTUP_TASK_STATE.enabled,
  );
  const state = packagedState(task.open);
  for (const input of [
    {
      args: [
        "--sync",
      ],
      hidden: false,
    },
    {
      args: [],
      hidden: true,
    },
  ]) {
    expect(() => enable(state, input)).toThrow(
      expect.objectContaining({
        code: "INVALID_ARGUMENT",
      }),
    );
  }
  expect(task.calls).toEqual([]);
});

test("disable and getStatus drive the same task", async () => {
  const task = fakeTask(STARTUP_TASK_STATE.enabled, STARTUP_TASK_STATE.enabled);
  const state = packagedState(task.open);
  expect((await getStatus(state)).registered).toBe(true);
  expect(await disable(state)).toBeNull();
  expect(task.calls).toEqual([
    "disable",
  ]);
  expect((await getStatus(state)).startupState).toBe("disabled");
});

test("an aborted call stops before touching WinRT", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(
    openStartupTask(controller.signal, () => Promise.resolve(null)),
  ).rejects.toMatchObject({
    code: "CANCELLED",
  });
});

// Without package identity Windows refuses the lookup. Reaching that refusal proves the activation
// class, the statics interface ID and the GetAsync slot are valid, and that cleanup does not fault.
test.skipIf(process.platform !== "win32")(
  "the WinRT binding reaches the StartupTask statics and fails cleanly without a package",
  async () => {
    const outcome = await openStartupTask(undefined, (task) =>
      Promise.resolve(task.state()),
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(outcome).toBeInstanceOf(BunawayError);
  },
);
