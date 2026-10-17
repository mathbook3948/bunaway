import { dlopen, ptr } from "bun:ffi";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import type { AppDefinition } from "@bunaway/core";
import {
  type AppRelaunchRequest,
  isAppRelaunchAck,
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
    // The relaunched host inherits the boot-time environment, not later changes by app code.
    const bootEnvironment = {
      ...process.env,
    };
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
    const cliManaged = devtools && process.send !== undefined;
    // How this host starts again after `relaunch()`; the working directory is the boot-time one.
    const host: HostLaunch = {
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
      env: bootEnvironment,
    };
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
      result = await runWindowsApp(
        app as AppDefinition,
        config,
        launch,
        inbox,
        // Under the CLI a relaunch is an IPC request, so only a direct start has a command line.
        cliManaged ? undefined : host,
      );
    } finally {
      // runWindowsApp also closes on shutdown; early import failures need this path.
      await inbox.close().catch(() => {});
    }
    // The app is fully stopped: start the replacement only now, so it never overlaps the old host.
    if (result.relaunch) {
      await relaunchHost(result.relaunch.argv, {
        dataRoot: config.dataRoot,
        cliManaged,
        host,
      });
    }
    process.exit(result.exitCode);
  } catch (error) {
    console.error(error);
    if (isCompiledApp) {
      await reportWindowsFailure(error, dataRoot, title);
    }
    process.exit(1);
  }
}

/** The slice of the Node IPC channel to a parent CLI that a relaunch request needs. */
export type HostIpc = {
  send?(message: unknown): unknown;
  on(
    event: "message" | "disconnect",
    listener: (message?: unknown) => void,
  ): unknown;
  off(
    event: "message" | "disconnect",
    listener: (message?: unknown) => void,
  ): unknown;
};

/** Longest wait for the CLI to acknowledge a relaunch request before this host exits anyway. */
export const RELAUNCH_ACK_TIMEOUT_MS = 2000;

/**
 * Sends the relaunch request and waits for the CLI's acknowledgement, which tells that the CLI
 * recorded it and will restart the host after this process exits. The wait ends at the
 * acknowledgement, a closed channel or the deadline, so the exit is never held up for long;
 * without an acknowledgement the CLI treats the exit as an ordinary one.
 */
export async function requestCliRelaunch(
  ipc: HostIpc,
  argv: readonly string[],
  timeoutMs = RELAUNCH_ACK_TIMEOUT_MS,
): Promise<void> {
  if (!ipc.send) {
    throw new Error("No channel to the development CLI");
  }
  await new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      ipc.off("message", onMessage);
      ipc.off("disconnect", done);
      resolve();
    };
    const onMessage = (message?: unknown) => {
      if (isAppRelaunchAck(message)) {
        done();
      }
    };
    const timer = setTimeout(done, timeoutMs);
    ipc.on("message", onMessage);
    ipc.on("disconnect", done);
    try {
      ipc.send?.({
        kind: "bunaway:relaunch-app",
        argv,
      } satisfies AppRelaunchRequest);
    } catch (error) {
      // A closed channel cannot acknowledge; surface the failure after cleaning up.
      done();
      console.error("Relaunch request failed:", error);
    }
  });
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
    /** The channel to the owning CLI; a parameter so the CLI branch is testable. */
    ipc?: HostIpc;
  },
): Promise<void> {
  try {
    if (options.cliManaged) {
      await requestCliRelaunch(options.ipc ?? process, argv);
      return;
    }
    const restoreFailure = startOutsideAppJob(
      relaunchCommand(options.host, argv),
    );
    if (restoreFailure !== undefined) {
      await logRelaunchDiagnostic(
        options.dataRoot,
        "relaunch-job-restore-failed",
        restoreFailure,
      );
    }
  } catch (error) {
    console.error("Relaunch failed:", error);
    await logRelaunchDiagnostic(options.dataRoot, "relaunch-failed", error);
  }
}

/** Records a relaunch problem in the host log; a log failure cannot change the exit. */
async function logRelaunchDiagnostic(
  dataRoot: string,
  event: string,
  error: unknown,
): Promise<void> {
  const log = new DiagnosticLog(resolve(dataRoot, "logs/host.log"));
  await log
    .write(event, {
      message: error instanceof Error ? error.message : String(error),
    })
    .catch(() => {});
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
