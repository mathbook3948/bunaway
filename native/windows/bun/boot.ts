import { dlopen, ptr } from "bun:ffi";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import type { AppDefinition } from "@bunaway/core";
import {
  APP_RELAUNCH_EXIT_CODE,
  type AppRelaunchRequest,
} from "@bunaway/runtime-bun/development";
import { DiagnosticLog } from "@bunaway/runtime-bun/diagnostic-log";
import { isCompiledApp, localAppData, verifyWindowsPackage } from "./config.ts";
import { runWindowsApp, type WindowsAppResult } from "./entry.ts";
import {
  forwardToInstance,
  instanceAddress,
  listenForInstances,
  parseLaunchArguments,
} from "./instance.ts";
import {
  AppAlreadyRunningError,
  containAppProcess,
  containAppProcessAfterRelaunch,
  startOutsideAppJob,
} from "./job.ts";
import {
  type HostLaunch,
  RELAUNCH_ENVIRONMENT,
  relaunchCommand,
} from "./relaunch.ts";

function object(value: unknown): Record<string, unknown> {
  assert(
    value && typeof value === "object" && !Array.isArray(value),
    "Invalid package configuration",
  );
  return value as Record<string, unknown>;
}
if (import.meta.main) {
  let dataRoot: string | undefined;
  let title = "Bunaway";
  try {
    dataRoot = resolve(
      localAppData(),
      "bunaway",
      basename(process.execPath, ".exe"),
    );
    const root = isCompiledApp
      ? dirname(process.execPath)
      : resolve(import.meta.dir, "..");
    const args = process.argv.slice(2);
    const devtools = !isCompiledApp && args[0] === "--devtools";
    if (devtools) {
      args.shift();
    }
    const developmentUrl =
      !isCompiledApp && args[0] === "--dev-url" ? args[1] : undefined;
    if (!isCompiledApp && args[0] === "--dev-url") {
      assert(developmentUrl, "Missing development URL");
    }
    const config = await verifyWindowsPackage(root, developmentUrl, devtools);
    dataRoot = config.dataRoot;
    title = config.windows[0]?.title ?? title;
    const launch = parseLaunchArguments({
      argv: developmentUrl ? args.slice(2) : args,
      cwd: process.cwd(),
    });
    // A relaunched host starts while its predecessor is still exiting, so it waits for the lock
    // instead of forwarding to the predecessor's closing pipe. The marker is not inherited further.
    const relaunched = process.env[RELAUNCH_ENVIRONMENT] === "1";
    delete process.env[RELAUNCH_ENVIRONMENT];
    // Claim this data directory before importing app code.
    try {
      if (relaunched) {
        await containAppProcessAfterRelaunch(config.dataRoot);
      } else {
        containAppProcess(config.dataRoot);
      }
    } catch (error) {
      if (!(error instanceof AppAlreadyRunningError)) {
        throw error;
      }
      await forwardToInstance(instanceAddress(config.dataRoot), launch);
      process.exit(0);
    }
    const inbox = await listenForInstances(instanceAddress(config.dataRoot));
    let result: WindowsAppResult;
    try {
      // Only the owner imports the app after IPC readiness. This literal also lets
      // bun build --compile include the application and its shared core chunk.
      // @ts-expect-error app.js is supplied by the host bundler.
      const module = await import("./app.js");
      const app = object(module.default);
      assert(
        app.commands && app.events,
        "App must default-export an AppDefinition",
      );
      result = await runWindowsApp(app as AppDefinition, config, launch, inbox);
    } finally {
      // runWindowsApp also closes on shutdown; early import failures need this path.
      await inbox.close().catch(() => {});
    }
    // The app is fully stopped: start the replacement only now, so it never overlaps the old host.
    let exitCode = result.exitCode;
    if (result.relaunch) {
      const cliManaged = devtools && process.send !== undefined;
      if (cliManaged) {
        exitCode = APP_RELAUNCH_EXIT_CODE;
      }
      await relaunchHost(result.relaunch.argv, {
        dataRoot: config.dataRoot,
        cliManaged,
        host: {
          compiled: isCompiledApp,
          execPath: process.execPath,
          execArgv: process.execArgv,
          script: process.argv[1],
          switches: [
            ...(devtools
              ? [
                  "--devtools",
                ]
              : []),
            ...(developmentUrl
              ? [
                  "--dev-url",
                  developmentUrl,
                ]
              : []),
          ],
          cwd: launch.cwd,
          env: process.env,
        },
      });
    }
    process.exit(exitCode);
  } catch (error) {
    console.error(error);
    if (isCompiledApp) {
      await reportWindowsFailure(error, dataRoot, title);
    }
    process.exit(1);
  }
}

/**
 * Starts the host again after an approved `relaunch()`.
 * Under `bunaway dev` the CLI owns the host process, so it is asked to restart it through IPC.
 * Otherwise a new process starts outside this app's Job. A refusal (for example an outer Job that
 * forbids breakaway) cannot be reported to the caller anymore: it is logged and this process still
 * exits with the requested code.
 */
export async function relaunchHost(
  argv: readonly string[],
  options: {
    dataRoot: string;
    cliManaged: boolean;
    host: HostLaunch;
  },
): Promise<void> {
  try {
    if (options.cliManaged) {
      await new Promise<void>((resolve, reject) =>
        process.send?.(
          {
            kind: "bunaway:relaunch-app",
            argv,
          } satisfies AppRelaunchRequest,
          (error: Error | null) => (error ? reject(error) : resolve()),
        ),
      );
      return;
    }
    startOutsideAppJob(relaunchCommand(options.host, argv));
  } catch (error) {
    console.error("Relaunch failed:", error);
    const log = new DiagnosticLog(resolve(options.dataRoot, "logs/host.log"));
    await log
      .write("relaunch-failed", {
        message: error instanceof Error ? error.message : String(error),
      })
      .catch(() => {});
  }
}

/**
 * Persists startup failures when possible, then shows a Windows dialog.
 * If logging fails, the original error text still appears there.
 */
export async function reportWindowsFailure(
  error: unknown,
  dataRoot: string | undefined,
  title: string,
) {
  const message = (
    error instanceof Error ? (error.stack ?? error.message) : String(error)
  ).slice(0, 16384);
  let detail = message;
  if (dataRoot) {
    const log = resolve(dataRoot, "logs/startup-error.log");
    try {
      await mkdir(dirname(log), {
        recursive: true,
      });
      await writeFile(log, message, "utf8");
      detail = `${message}\n\nLog: ${log}`;
    } catch {
      /* A startup failure must still be visible if the log cannot be written. */
    }
  }
  const user = dlopen("user32.dll", {
    MessageBoxW: {
      args: [
        "u64",
        "ptr",
        "ptr",
        "u32",
      ],
      returns: "i32",
    },
  });
  const text = Buffer.from(`${detail}\0`, "utf16le");
  const caption = Buffer.from(`${title}\0`, "utf16le");
  try {
    user.symbols.MessageBoxW(0n, ptr(text), ptr(caption), 0x10);
  } finally {
    user.close();
  }
}
