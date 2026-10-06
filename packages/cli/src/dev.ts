import { watch } from "node:fs";
import { dirname, relative } from "node:path";
import { type BuiltPackage, type NativeInputs, buildProject, prepareNative } from "./build.ts";
import { type Project, validateProject } from "./config.ts";
import { type DevServer, startDevServer } from "./dev-server.ts";
import { closeWindowsApp, verifyWindowsLaunch, windowsLaunchEnvironment } from "./launch.ts";

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

export function shouldRestartHost(project: Project, name: string): boolean {
  const path = name.replaceAll("\\", "/");
  if (/^(node_modules|vendor|dist|\.bunaway|\.git|\.next|\.turbo)(\/|$)/.test(path)) return false;
  if (!project.dev) return true;
  // Frontend files and dev-server outputs belong to that server's watcher.
  const backendDirectories = [
    project.backend,
    ...(project.windowsApp ? [project.windowsApp] : []),
  ].map((entry) => relative(project.root, dirname(entry)).replaceAll("\\", "/"));
  return (
    ["package.json", "bun.lock", "tsconfig.json"].includes(path) ||
    path.startsWith("src-bunaway/") ||
    backendDirectories.some((directory) =>
      directory ? path === directory || path.startsWith(`${directory}/`) : !path.includes("/"),
    )
  );
}

export async function devProject(directory: string): Promise<void> {
  let project = await validateProject(directory, { development: true });
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
      return buildProject(project.root, { development: true, native });
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
      const current = Bun.spawn([built.executable, ...built.arguments], {
        cwd: built.package,
        env: environment,
        stdin: "ignore",
        stdout: "inherit",
        stderr: "inherit",
      });
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
      if (!name || !shouldRestartHost(project, String(name)) || abort.signal.aborted) return;
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
