import { watch } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { AppReloadResult } from "@bunaway/runtime-bun/development";
import { bundleWindowsReload } from "./assets.ts";
import {
  type BuiltPackage,
  buildProject,
  type NativeInputs,
  prepareNative,
} from "./build.ts";
import {
  type Project,
  readProjectConfiguration,
  validateProject,
} from "./config.ts";
import { type DevServer, startDevServer } from "./dev-server.ts";
import { inside } from "./files.ts";
import { WindowsAppReload } from "./windows-app-reload.ts";
import {
  closeWindowsApp,
  verifyWindowsLaunch,
  windowsInspectorArgument,
  windowsLaunchEnvironment,
} from "./windows-dev-launch.ts";

const SOURCE_DEBOUNCE_MS = 150;

export function parseDevArguments(args: string[]): {
  directory: string;
  inspect?: number;
} {
  let directory: string | undefined;
  let inspect: number | undefined;
  for (const arg of args) {
    if (arg === "--inspect" || arg.startsWith("--inspect=")) {
      if (inspect !== undefined) {
        throw new Error("Specify --inspect only once.");
      }
      const value =
        arg === "--inspect" ? "6499" : arg.slice("--inspect=".length);
      if (!/^[0-9]+$/.test(value)) {
        throw new Error("Use --inspect or --inspect=<port>.");
      }
      inspect = Number(value);
      windowsInspectorArgument(inspect);
    } else if (arg.startsWith("--") || directory !== undefined) {
      throw new Error("Usage: bunaway dev [directory] [--inspect[=<port>]].");
    } else {
      directory = arg;
    }
  }
  return {
    directory: directory ?? ".",
    ...(inspect === undefined
      ? {}
      : {
          inspect,
        }),
  };
}

export class RestartController<T> {
  private revision = 0;
  private stopped = false;
  private running: Promise<void> | undefined;
  private debounce:
    | {
        ready: Promise<void>;
        cancel(): void;
      }
    | undefined;
  constructor(
    private readonly hooks: {
      stop(): Promise<void>;
      build(): Promise<T>;
      start(value: T): Promise<void>;
      error(error: unknown): void;
      reload?(isCurrent: () => boolean): Promise<boolean>;
    },
  ) {}

  change(delayMs = 0): Promise<void> {
    if (this.stopped) {
      return Promise.resolve();
    }
    this.revision += 1;
    this.debounce?.cancel();
    this.debounce = undefined;
    if (delayMs > 0) {
      const { promise, resolve } = Promise.withResolvers<void>();
      const timer = setTimeout(() => {
        this.debounce = undefined;
        resolve();
      }, delayMs);
      this.debounce = {
        ready: promise,
        cancel() {
          clearTimeout(timer);
          resolve();
        },
      };
    }
    if (!this.running) {
      this.running = this.restart().finally(() => {
        this.running = undefined;
      });
    }
    return this.running;
  }

  private async restart(): Promise<void> {
    let applied = 0;
    while (!this.stopped && applied !== this.revision) {
      while (!this.stopped && this.debounce) {
        await this.debounce.ready;
      }
      if (this.stopped) {
        break;
      }
      applied = this.revision;
      try {
        if (
          await this.hooks.reload?.(
            () => !this.stopped && applied === this.revision,
          )
        ) {
          continue;
        }
        if (this.stopped || applied !== this.revision) {
          continue;
        }
        await this.hooks.stop();
        if (this.stopped) {
          break;
        }
        const result = await this.hooks.build();
        if (!this.stopped && applied === this.revision) {
          await this.hooks.start(result);
        }
      } catch (error) {
        this.hooks.error(error);
      }
    }
  }

  async close(): Promise<void> {
    this.stopped = true;
    this.debounce?.cancel();
    this.debounce = undefined;
    await this.running;
    await this.hooks.stop();
  }
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

export function isAppCodeChange(project: Project, name: string): boolean {
  const path = name.replaceAll("\\", "/");
  if (
    !project.dev &&
    (inside(project.frontend, resolve(project.root, path)) ||
      project.frontendDependencies?.includes(path))
  ) {
    return false;
  }
  if (
    [
      "package.json",
      "bun.lock",
      "tsconfig.json",
    ].includes(path)
  ) {
    return false;
  }
  if (
    !/\.[cm]?[jt]sx?$/.test(path) &&
    !project.backendDependencies?.includes(path)
  ) {
    return false;
  }
  const directory = relative(
    project.root,
    dirname(project.appEntry),
  ).replaceAll("\\", "/");
  return (
    project.backendDependencies?.includes(path) === true ||
    (directory ? path.startsWith(`${directory}/`) : !path.includes("/"))
  );
}

export function shouldRestartHost(
  project: Project,
  name: string,
  recovering = false,
): boolean {
  const path = name.replaceAll("\\", "/");
  if (
    /^(node_modules|vendor|dist|\.bunaway|\.git|\.next|\.turbo)(\/|$)/.test(
      path,
    )
  ) {
    return false;
  }
  if (!project.dev || recovering) {
    return true;
  }
  // Frontend files and dev-server outputs belong to that server's watcher.
  const backendDirectories = [
    project.appEntry,
  ].map((entry) =>
    relative(project.root, dirname(entry)).replaceAll("\\", "/"),
  );
  const icon = project.app.icon
    ? relative(project.root, resolve(project.root, project.app.icon))
        .replaceAll("\\", "/")
        .toLowerCase()
    : undefined;
  return (
    (icon !== undefined &&
      (icon === path.toLowerCase() ||
        icon.startsWith(`${path.toLowerCase()}/`))) ||
    project.backendDependencies?.some(
      (dependency) => dependency === path || dependency.startsWith(`${path}/`),
    ) ||
    [
      "package.json",
      "bun.lock",
      "tsconfig.json",
    ].includes(path) ||
    path.startsWith("src-bunaway/") ||
    backendDirectories.some((directory) =>
      directory
        ? path === directory || path.startsWith(`${directory}/`)
        : !path.includes("/"),
    )
  );
}

export async function devProject(
  directory: string,
  options: {
    inspect?: number;
  } = {},
): Promise<void> {
  if (options.inspect !== undefined && process.platform !== "win32") {
    throw new Error(
      "Backend --inspect is currently supported on Windows x64 only.",
    );
  }
  const inspector =
    options.inspect === undefined
      ? undefined
      : windowsInspectorArgument(options.inspect);
  let project = await readProjectConfiguration(directory);
  let recovering = true;
  const abort = new AbortController();
  let native: NativeInputs;
  let server: DevServer | undefined;
  let serverSettings: string | undefined;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let reloadConnection: WindowsAppReload | undefined;
  let runningBuild: BuiltPackage | undefined;
  let runningSettings: ReturnType<typeof launchSettings> | undefined;
  const changedFiles = new Set<string>();
  let restarting = false;
  let fatal: Error | undefined;
  let resolveExit: (() => void) | undefined;
  const done = new Promise<void>((resolveDone) => {
    resolveExit = resolveDone;
  });
  const onSignal = () => {
    abort.abort();
    resolveExit?.();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  async function syncServer(next: Project) {
    const settings = next.dev ? JSON.stringify(next.dev) : undefined;
    if (settings === serverSettings) {
      return;
    }
    const previous = server;
    server = undefined;
    serverSettings = undefined;
    await previous?.stop();
    if (next.dev) {
      const current = await startDevServer(
        next.dev,
        next.root,
        abort.signal,
        next.frameworkRoot,
      );
      server = current;
      serverSettings = settings;
      void current.exited.then((code) => {
        if (server === current && !abort.signal.aborted) {
          fatal = new Error(
            `Frontend development server exited (exit ${code}). Restart bunaway dev.`,
          );
          abort.abort();
          resolveExit?.();
        }
      });
    }
  }

  const controller = new RestartController<BuiltPackage>({
    async reload(isCurrent) {
      if (
        process.platform !== "win32" ||
        !child ||
        !reloadConnection ||
        !runningBuild
      ) {
        return false;
      }
      if (
        !(await Bun.file(
          resolve(runningBuild.package, "assets/development-sdk.json"),
        ).exists())
      ) {
        return false;
      }
      const next = await validateProject(project.root, {
        development: true,
      });
      if (
        [
          ...changedFiles,
        ].some((name) => !isAppCodeChange(next, name))
      ) {
        return false;
      }
      if (!isDeepStrictEqual(runningSettings, launchSettings(next))) {
        return false;
      }
      const id = crypto.randomUUID();
      const sha256 = await bundleWindowsReload(
        next,
        resolve(runningBuild.package, "assets"),
        id,
      );
      if (!isCurrent()) {
        return true;
      }
      let result: AppReloadResult;
      try {
        result = await reloadConnection.reload({
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
      project = next;
      recovering = false;
      if (isCurrent()) {
        changedFiles.clear();
      }
      console.log(
        "App code reloaded; windows, state, sessions and subscriptions retained.",
      );
      return true;
    },
    async stop() {
      if (!child) {
        return;
      }
      restarting = true;
      const previous = child;
      child = undefined;
      reloadConnection?.close();
      reloadConnection = undefined;
      runningBuild = undefined;
      try {
        if (process.platform === "win32") {
          const deadline = Date.now() + 40000;
          let posted = false;
          while (previous.exitCode === null && Date.now() < deadline) {
            if (!posted) {
              posted = (await closeWindowsApp(previous.pid)) > 0;
            }
            await Bun.sleep(20);
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
      } finally {
        restarting = false;
      }
    },
    async build() {
      abort.signal.throwIfAborted();
      const next = await validateProject(project.root, {
        development: true,
      });
      try {
        await syncServer(next);
      } catch (error) {
        if (!abort.signal.aborted) {
          fatal = error instanceof Error ? error : new Error(String(error));
          resolveExit?.();
        }
        throw error;
      }
      project = next;
      abort.signal.throwIfAborted();
      const built = await buildProject(project.root, {
        development: true,
        native,
      });
      recovering = false;
      return built;
    },
    async start(built) {
      changedFiles.clear();
      if (abort.signal.aborted) {
        return;
      }
      if (process.platform === "win32") {
        await verifyWindowsLaunch(built.package);
      }
      if (abort.signal.aborted) {
        return;
      }
      console.log(
        project.dev
          ? "Starting native host; frontend updates use the development server's HMR."
          : "Starting a fresh host/runtime/session; pending requests are not replayed.",
      );
      const environment =
        process.platform === "win32" ? windowsLaunchEnvironment() : process.env;
      if (process.platform === "win32") {
        console.log(
          "UI DevTools: focus the WebView and press F12 or Ctrl+Shift+I.",
        );
      }
      if (inspector) {
        console.log(
          `Backend inspector: ws://127.0.0.1:${options.inspect}/bunaway (Bun/WebKit inspector protocol). Reconnect after a backend restart.`,
        );
      }
      const connection =
        process.platform === "win32" ? new WindowsAppReload() : undefined;
      const current = Bun.spawn(
        [
          built.executable,
          ...(inspector
            ? [
                inspector,
              ]
            : []),
          ...built.arguments,
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
      child = current;
      connection?.attach(current);
      reloadConnection = connection;
      runningBuild = built;
      runningSettings = launchSettings(project);
      void current.exited.then((code) => {
        if (!restarting && child === current) {
          console.log(`Host exited (${code}).`);
          if (code !== 0) {
            fatal = new Error(`Native host exited (exit ${code}).`);
          }
          resolveExit?.();
        }
      });
    },
    error(error) {
      recovering = true;
      if (!abort.signal.aborted) {
        console.error(
          `Dev build failed${child ? "; running app retained" : ""}; fix sources and save to retry: ${String(error)}`,
        );
      }
    },
  });
  let sourceWatcher: ReturnType<typeof watch> | undefined;
  try {
    native = await prepareNative(undefined, project.frameworkRoot);
    abort.signal.throwIfAborted();
    sourceWatcher = watch(
      project.root,
      {
        recursive: true,
      },
      (_event, name) => {
        if (
          !name ||
          !shouldRestartHost(project, String(name), recovering) ||
          abort.signal.aborted
        ) {
          return;
        }
        changedFiles.add(String(name));
        // Invalidate immediately, before a reload can clear these pending changes.
        void controller.change(SOURCE_DEBOUNCE_MS);
      },
    );
    await controller.change();
    await done;
    if (fatal) {
      throw fatal;
    }
  } catch (error) {
    if (!abort.signal.aborted || fatal) {
      throw error;
    }
  } finally {
    sourceWatcher?.close();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    abort.abort();
    try {
      await controller.close();
    } finally {
      const previous = server;
      server = undefined;
      await previous?.stop();
    }
  }
}
