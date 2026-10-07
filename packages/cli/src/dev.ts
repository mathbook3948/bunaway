import { watch } from "node:fs";
import { dirname, relative } from "node:path";
import { type BuiltPackage, buildProject, type NativeInputs, prepareNative } from "./build.ts";
import { type Project, readProjectConfiguration, validateProject } from "./config.ts";
import { type DevServer, startDevServer } from "./dev-server.ts";
import {
  closeWindowsApp,
  verifyWindowsLaunch,
  windowsInspectorArgument,
  windowsLaunchEnvironment,
} from "./launch.ts";

export function parseDevArguments(args: string[]): { directory: string; inspect?: number } {
  let directory: string | undefined;
  let inspect: number | undefined;
  for (const arg of args) {
    if (arg === "--inspect" || arg.startsWith("--inspect=")) {
      if (inspect !== undefined) throw new Error("Specify --inspect only once.");
      const value = arg === "--inspect" ? "6499" : arg.slice("--inspect=".length);
      if (!/^[0-9]+$/.test(value)) throw new Error("Use --inspect or --inspect=<port>.");
      inspect = Number(value);
      windowsInspectorArgument(inspect);
    } else if (arg.startsWith("--") || directory !== undefined) {
      throw new Error("Usage: bunaway dev [directory] [--inspect[=<port>]].");
    } else directory = arg;
  }
  return { directory: directory ?? ".", ...(inspect === undefined ? {} : { inspect }) };
}

export class RestartController<T> {
  private revision = 0;
  private stopped = false;
  private running: Promise<void> | undefined;
  constructor(
    private readonly hooks: {
      stop(): Promise<void>;
      build(): Promise<T>;
      start(value: T): Promise<void>;
      error(error: unknown): void;
    },
  ) {}

  change(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.revision += 1;
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
      applied = this.revision;
      try {
        await this.hooks.stop();
        if (this.stopped) break;
        const result = await this.hooks.build();
        if (!this.stopped && applied === this.revision) await this.hooks.start(result);
      } catch (error) {
        this.hooks.error(error);
      }
    }
  }

  async close(): Promise<void> {
    this.stopped = true;
    await this.running;
    await this.hooks.stop();
  }
}

export function shouldRestartHost(project: Project, name: string, recovering = false): boolean {
  const path = name.replaceAll("\\", "/");
  if (/^(node_modules|vendor|dist|\.bunaway|\.git|\.next|\.turbo)(\/|$)/.test(path)) return false;
  if (!project.dev || recovering) return true;
  // Frontend files and dev-server outputs belong to that server's watcher.
  const backendDirectories = [project.appEntry].map((entry) =>
    relative(project.root, dirname(entry)).replaceAll("\\", "/"),
  );
  return (
    project.backendDependencies?.some(
      (dependency) => dependency === path || dependency.startsWith(`${path}/`),
    ) ||
    ["package.json", "bun.lock", "tsconfig.json"].includes(path) ||
    path.startsWith("src-bunaway/") ||
    backendDirectories.some((directory) =>
      directory ? path === directory || path.startsWith(`${directory}/`) : !path.includes("/"),
    )
  );
}

export async function devProject(
  directory: string,
  options: { inspect?: number } = {},
): Promise<void> {
  if (options.inspect !== undefined && process.platform !== "win32")
    throw new Error("Backend --inspect is currently supported on Windows x64 only.");
  const inspector =
    options.inspect === undefined ? undefined : windowsInspectorArgument(options.inspect);
  let project = await readProjectConfiguration(directory);
  let recovering = true;
  const abort = new AbortController();
  let native: NativeInputs;
  let server: DevServer | undefined;
  let serverSettings: string | undefined;
  let child: ReturnType<typeof Bun.spawn> | undefined;
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
    if (settings === serverSettings) return;
    const previous = server;
    server = undefined;
    serverSettings = undefined;
    await previous?.stop();
    if (next.dev) {
      const current = await startDevServer(next.dev, next.root, abort.signal, next.frameworkRoot);
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
    async stop() {
      if (!child) return;
      restarting = true;
      const previous = child;
      child = undefined;
      try {
        if (process.platform === "win32") {
          const deadline = Date.now() + 40000;
          let posted = false;
          while (previous.exitCode === null && Date.now() < deadline) {
            if (!posted) posted = (await closeWindowsApp(previous.pid)) > 0;
            await Bun.sleep(20);
          }
          if (previous.exitCode === null) {
            previous.kill();
            await previous.exited;
            throw new Error("Windows app cleanup timed out; restart stopped.");
          }
        } else previous.kill();
        await previous.exited;
      } finally {
        restarting = false;
      }
    },
    async build() {
      abort.signal.throwIfAborted();
      const next = await validateProject(project.root, { development: true });
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
      const built = await buildProject(project.root, { development: true, native });
      recovering = false;
      return built;
    },
    async start(built) {
      if (abort.signal.aborted) return;
      if (process.platform === "win32") await verifyWindowsLaunch(built.package);
      if (abort.signal.aborted) return;
      console.log(
        project.dev
          ? "Starting native host; frontend updates use the development server's HMR."
          : "Starting a fresh host/runtime/session; pending requests are not replayed.",
      );
      const environment = process.platform === "win32" ? windowsLaunchEnvironment() : process.env;
      if (process.platform === "win32")
        console.log("UI DevTools: focus the WebView and press F12 or Ctrl+Shift+I.");
      if (inspector)
        console.log(
          `Backend inspector: ws://127.0.0.1:${options.inspect}/bunaway (Bun/WebKit inspector protocol). Reconnect after a backend restart.`,
        );
      const current = Bun.spawn(
        [built.executable, ...(inspector ? [inspector] : []), ...built.arguments],
        {
          cwd: built.package,
          env: environment,
          stdin: "ignore",
          stdout: "inherit",
          stderr: "inherit",
        },
      );
      child = current;
      void current.exited.then((code) => {
        if (!restarting && child === current) {
          console.log(`Host exited (${code}).`);
          if (code !== 0) fatal = new Error(`Native host exited (exit ${code}).`);
          resolveExit?.();
        }
      });
    },
    error(error) {
      recovering = true;
      if (!abort.signal.aborted)
        console.error(`Dev build failed; fix sources and save to retry: ${String(error)}`);
    },
  });
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let sourceWatcher: ReturnType<typeof watch> | undefined;
  try {
    native = await prepareNative(undefined, project.frameworkRoot);
    abort.signal.throwIfAborted();
    sourceWatcher = watch(project.root, { recursive: true }, (_event, name) => {
      if (!name || !shouldRestartHost(project, String(name), recovering) || abort.signal.aborted)
        return;
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        void controller.change();
      }, 150);
    });
    await controller.change();
    await done;
    if (fatal) throw fatal;
  } catch (error) {
    if (!abort.signal.aborted || fatal) throw error;
  } finally {
    clearTimeout(debounce);
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
