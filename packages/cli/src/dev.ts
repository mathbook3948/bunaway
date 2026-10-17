import {
  type BuiltPackage,
  buildProject,
  type NativeInputs,
  prepareNative,
} from "./build.ts";
import { readProjectConfiguration, validateProject } from "./config.ts";
import { DevApp } from "./dev-app.ts";
import { DevFrontend } from "./dev-frontend.ts";
import { DevWatcher } from "./dev-watcher.ts";
import { RestartController } from "./restart-controller.ts";
import { windowsInspectorArgument } from "./windows-dev-launch.ts";

export { isAppCodeChange, shouldRestartHost } from "./dev-watcher.ts";
export { RestartController } from "./restart-controller.ts";

/** Parses a project directory and an optional loopback backend inspector port. */
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

/** Runs the watched development lifecycle until a signal or owned process exits.
 * Windows app-code edits try an in-place reload; launch-setting changes need a fresh host.
 * Failed source builds leave the watcher active for another save.
 */
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
  let native: NativeInputs;
  let fatal: Error | undefined;
  const abort = new AbortController();
  const done = Promise.withResolvers<void>();
  const onSignal = () => {
    abort.abort();
    done.resolve();
  };
  const frontend = new DevFrontend(abort.signal, (error) => {
    fatal = error;
    onSignal();
  });
  const app = new DevApp(
    abort.signal,
    (code) => {
      console.log(`Host exited (${code}).`);
      if (code !== 0) {
        fatal = new Error(`Native host exited (exit ${code}).`);
      }
      done.resolve();
    },
    inspector,
    options.inspect,
    undefined,
    // The app asked to relaunch: restart the host through the normal path, keeping the session.
    () => {
      void controller.change();
    },
  );
  const sources = new DevWatcher(
    {
      project: () => project,
      recovering: () => recovering,
    },
    abort.signal,
    (delayMs) => {
      void controller.change(delayMs);
    },
  );
  const controller = new RestartController<BuiltPackage>({
    async reload(isCurrent) {
      if (!(await app.canReload())) {
        return false;
      }
      const next = await validateProject(project.root, {
        development: true,
      });
      if (!(await app.reload(next, sources.pendingChanges, isCurrent))) {
        return false;
      }
      if (isCurrent()) {
        project = next;
        recovering = false;
        sources.clear();
        console.log(
          "App code reloaded; windows, state, sessions and subscriptions retained.",
        );
      }
      return true;
    },
    stop: () => app.stop(),
    async build() {
      abort.signal.throwIfAborted();
      const next = await validateProject(project.root, {
        development: true,
      });
      try {
        await frontend.sync(next);
      } catch (error) {
        if (!abort.signal.aborted) {
          fatal = error instanceof Error ? error : new Error(String(error));
          done.resolve();
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
    async start(built, isCurrent) {
      await app.start(project, built, isCurrent);
      if (app.running && isCurrent()) {
        sources.clear();
      }
    },
    error(error) {
      recovering = true;
      if (!abort.signal.aborted) {
        console.error(
          `Dev build failed${app.running ? "; running app retained" : ""}; fix sources and save to retry: ${String(error)}`,
        );
      }
    },
  });
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    native = await prepareNative(undefined, project.frameworkRoot);
    abort.signal.throwIfAborted();
    sources.start();
    await controller.change();
    await done.promise;
    if (fatal) {
      throw fatal;
    }
  } catch (error) {
    if (!abort.signal.aborted || fatal) {
      throw error;
    }
  } finally {
    sources.close();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    abort.abort();
    try {
      await controller.close();
    } finally {
      // Keep the frontend available until native app cleanup finishes.
      await frontend.close();
    }
  }
}
