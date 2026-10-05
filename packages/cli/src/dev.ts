import { watch } from "node:fs";
import { buildProject, type BuiltPackage, prepareNative } from "./build.ts";
import { validateProject } from "./config.ts";

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

export async function devProject(directory: string): Promise<void> {
  const project = await validateProject(directory);
  const native = await prepareNative();
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let restarting = false;
  let resolveExit: (() => void) | undefined;
  const done = new Promise<void>((resolveDone) => {
    resolveExit = resolveDone;
  });
  const controller = new RestartController<BuiltPackage>({
    async stop() {
      if (!child) return;
      restarting = true;
      const previous = child;
      child = undefined;
      previous.kill();
      await previous.exited;
      restarting = false;
    },
    build: () => buildProject(project.root, { development: true, native }),
    async start(built) {
      console.log("Starting a fresh host/runtime/session; pending requests are not replayed.");
      const current = Bun.spawn([built.executable, "--package", built.package], {
        cwd: project.root,
        stdin: "ignore",
        stdout: "inherit",
        stderr: "inherit",
      });
      child = current;
      void current.exited.then((code) => {
        if (!restarting && child === current) {
          console.log(`Host exited (${code}).`);
          resolveExit?.();
        }
      });
    },
    error(error) {
      console.error(`Dev build failed; fix sources and save to retry: ${String(error)}`);
    },
  });
  let debounce: ReturnType<typeof setTimeout> | undefined;
  const changed = () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      void controller.change();
    }, 150);
  };
  const sourceWatcher = watch(project.root, { recursive: true }, (_event, name) => {
    if (!name) return;
    const path = String(name).replaceAll("\\", "/");
    if (!/^(node_modules|vendor|dist|\.bunaway|\.git)(\/|$)/.test(path)) changed();
  });
  const onSignal = () => {
    resolveExit?.();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    await controller.change();
    await done;
  } finally {
    clearTimeout(debounce);
    sourceWatcher.close();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await controller.close();
  }
}
