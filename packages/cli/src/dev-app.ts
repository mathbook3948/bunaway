import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { AppReloadResult } from "@bunaway/runtime-bun/development";
import type { Subprocess } from "bun";
import { bundleWindowsReload } from "./assets.ts";
import type { BuiltPackage } from "./build.ts";
import type { Project } from "./config.ts";
import { isAppCodeChange } from "./dev-watcher.ts";
import { WindowsAppReload } from "./windows-app-reload.ts";
import {
  closeWindowsApp,
  verifyWindowsLaunch,
  windowsLaunchEnvironment,
} from "./windows-dev-launch.ts";

/** The process and optional reload channel transferred by a successful app launch. */
export interface RunningDevApp {
  process: Pick<Subprocess, "exited" | "exitCode" | "pid" | "kill">;
  connection:
    | (Pick<WindowsAppReload, "reload" | "close"> &
        Partial<Pick<WindowsAppReload, "relaunch">>)
    | undefined;
}

/** Platform operations used by the app owner; a failed launch must release partial resources. */
export interface DevAppOperations {
  launch(
    project: Project,
    built: BuiltPackage,
    isCurrent: () => boolean,
    /** App arguments after the host switches; set by an app-requested relaunch. */
    appArguments: readonly string[],
  ): Promise<RunningDevApp | undefined>;
  stop(app: RunningDevApp): Promise<void>;
}

const WINDOWS_CLEANUP_TIMEOUT_MS = 40000;
const WINDOWS_CLEANUP_POLL_MS = 20;

/** Stops the app after its reload channel closes, waiting for native cleanup on Windows. */
async function stopDevApp(app: RunningDevApp): Promise<void> {
  const previous = app.process;
  if (process.platform === "win32") {
    const deadline = Date.now() + WINDOWS_CLEANUP_TIMEOUT_MS;
    let posted = false;
    while (previous.exitCode === null && Date.now() < deadline) {
      if (!posted) {
        // Let the Windows message loop tear down before force-killing on timeout.
        posted = (await closeWindowsApp(previous.pid)) > 0;
      }
      await Bun.sleep(WINDOWS_CLEANUP_POLL_MS);
    }
    if (previous.exitCode === null) {
      previous.kill();
      await previous.exited;
      throw new Error("Windows app cleanup timed out; restart stopped.");
    }
  } else {
    previous.kill();
  }
  await previous.exited;
}

/** Verifies the package before spawning and transfers process and IPC ownership together. */
async function launchDevApp(
  project: Project,
  built: BuiltPackage,
  signal: AbortSignal,
  inspector: string | undefined,
  inspectPort: number | undefined,
  isCurrent: () => boolean,
  appArguments: readonly string[],
): Promise<RunningDevApp | undefined> {
  if (signal.aborted || !isCurrent()) {
    return;
  }
  if (process.platform === "win32") {
    await verifyWindowsLaunch(built.package);
  }
  if (signal.aborted || !isCurrent()) {
    return;
  }
  console.log(
    project.dev
      ? "Starting native host; frontend updates use the development server's HMR."
      : "Starting a fresh host/runtime/session; pending requests are not replayed.",
  );
  const environment =
    process.platform === "win32"
      ? windowsLaunchEnvironment()
      : {
          HOME: process.env.HOME,
          TMPDIR: process.env.TMPDIR,
          PATH: "/usr/bin:/bin",
          BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
          DO_NOT_TRACK: "1",
        };
  if (process.platform === "win32") {
    console.log(
      "UI DevTools: focus the WebView and press F12 or Ctrl+Shift+I.",
    );
  }
  if (inspector) {
    console.log(
      `Backend inspector: ws://127.0.0.1:${inspectPort}/bunaway (Bun/WebKit inspector protocol). Reconnect after a backend restart.`,
    );
  }
  const connection =
    process.platform === "win32" ? new WindowsAppReload() : undefined;
  let current: ReturnType<typeof Bun.spawn>;
  try {
    current = Bun.spawn(
      [
        built.executable,
        ...(inspector
          ? [
              inspector,
            ]
          : []),
        ...built.arguments,
        ...appArguments,
      ],
      {
        cwd: built.package,
        env: environment,
        stdin: "ignore",
        stdout: "inherit",
        stderr: "inherit",
        ...(process.platform === "win32"
          ? {
              ipc: (message) => connection?.receive(message),
            }
          : {}),
      },
    );
  } catch (error) {
    connection?.close();
    throw error;
  }
  connection?.attach(current);
  return {
    process: current,
    connection,
  };
}

function launchSettings(project: Project) {
  return {
    appEntry: project.appEntry,
    frontend: project.frontend,
    app: project.app,
    policy: project.policy,
    dev: project.dev,
    nativePlugins: project.nativePlugins,
    buildCommand: project.buildCommand,
  };
}

/** Owns the active app, its reload channel and the launch settings that permit code reloads. */
export class DevApp {
  private active:
    | (RunningDevApp & {
        built: BuiltPackage;
        settings: ReturnType<typeof launchSettings>;
      })
    | undefined;
  private stopping: Promise<void> | undefined;
  /** Arguments the next host receives; replaced by an app-requested relaunch. */
  private appArguments: readonly string[] = [];

  /**
   * @param relaunched Called after a host that asked for a relaunch exited; the caller starts a
   *   fresh host through its normal restart path, so the development session continues.
   */
  constructor(
    private readonly signal: AbortSignal,
    private readonly exited: (code: number) => void,
    inspector: string | undefined = undefined,
    inspectPort: number | undefined = undefined,
    private readonly operations: DevAppOperations = {
      launch: (project, built, isCurrent, appArguments) =>
        launchDevApp(
          project,
          built,
          signal,
          inspector,
          inspectPort,
          isCurrent,
          appArguments,
        ),
      stop: stopDevApp,
    },
    private readonly relaunched: () => void = () => {},
  ) {}

  get running(): boolean {
    return this.active !== undefined;
  }

  /** Starts only a current revision; cancellation of an in-flight launch reclaims its result. */
  async start(
    project: Project,
    built: BuiltPackage,
    isCurrent: () => boolean,
  ): Promise<void> {
    if (this.signal.aborted || !isCurrent()) {
      return;
    }
    const app = await this.operations.launch(
      project,
      built,
      isCurrent,
      this.appArguments,
    );
    if (!app) {
      return;
    }
    // Relaunch arguments apply to this one host only, like a packaged app's relaunch.
    this.appArguments = [];
    this.active = {
      ...app,
      built,
      settings: launchSettings(project),
    };
    if (this.signal.aborted || !isCurrent()) {
      await this.stop();
      return;
    }
    const current = this.active;
    void app.process.exited.then((code) => {
      if (this.active !== current || this.signal.aborted) {
        return;
      }
      // The host exits only after the CLI acknowledged its relaunch request, so a request that
      // was made is already recorded here, whatever the exit code is.
      const relaunch = current.connection?.relaunch;
      if (relaunch !== undefined) {
        // The app asked to start again: keep the session and launch a fresh host.
        this.appArguments = relaunch;
        void this.stop().then(this.relaunched);
        return;
      }
      this.exited(code);
    });
  }

  /** Detaches the old app before termination so its expected exit cannot end the dev session. */
  stop(): Promise<void> {
    if (this.stopping) {
      return this.stopping;
    }
    const previous = this.active;
    this.active = undefined;
    if (!previous) {
      return Promise.resolve();
    }
    previous.connection?.close();
    this.stopping = this.operations.stop(previous).finally(() => {
      this.stopping = undefined;
    });
    return this.stopping;
  }

  /** Checks availability before validating source for a compatible reload. */
  async canReload(): Promise<boolean> {
    const current = this.active;
    return (
      process.platform === "win32" &&
      current?.connection !== undefined &&
      (await Bun.file(
        resolve(current.built.package, "assets/manifest.json"),
      ).exists())
    );
  }

  /** Tries app-code replacement while retaining the current process and native resources.
   * Returns false for launch changes or channel failure; source/reload failures retain the app.
   */
  async reload(
    next: Project,
    changes: readonly string[],
    isCurrent: () => boolean,
  ): Promise<boolean> {
    const current = this.active;
    if (process.platform !== "win32" || !current?.connection) {
      return false;
    }
    if (
      changes.some((name) => !isAppCodeChange(next, name)) ||
      !isDeepStrictEqual(current.settings, launchSettings(next))
    ) {
      return false;
    }
    const id = crypto.randomUUID();
    const sha256 = await bundleWindowsReload(
      next,
      resolve(current.built.package, "assets"),
      id,
    );
    if (!isCurrent()) {
      return true;
    }
    let result: AppReloadResult;
    try {
      result = await current.connection.reload({
        kind: "bunaway:reload-app",
        id,
        sha256,
      });
    } catch (error) {
      console.error("App reload connection failed; restarting host:", error);
      return false;
    }
    if (result.status === "restart") {
      return false;
    }
    if (result.status === "failed") {
      throw new Error(result.message ?? "App reload failed.");
    }
    return true;
  }
}
