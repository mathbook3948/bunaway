import { dlopen, ptr } from "bun:ffi";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import type { AppDefinition } from "@bunaway/core";
import { isCompiledApp, localAppData, verifyWindowsPackage } from "./config.ts";
import { runWindowsApp } from "./entry.ts";
import {
  forwardToInstance,
  instanceAddress,
  listenForInstances,
  parseLaunchArguments,
} from "./instance.ts";
import { AppAlreadyRunningError, containAppProcess } from "./job.ts";

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
    // Claim this data directory before importing app code.
    try {
      containAppProcess(config.dataRoot);
    } catch (error) {
      if (!(error instanceof AppAlreadyRunningError)) {
        throw error;
      }
      await forwardToInstance(instanceAddress(config.dataRoot), launch);
      process.exit(0);
    }
    const inbox = await listenForInstances(instanceAddress(config.dataRoot));
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
      await runWindowsApp(app as AppDefinition, config, launch, inbox);
    } finally {
      // runWindowsApp also closes on shutdown; early import failures need this path.
      await inbox.close().catch(() => {});
    }
    process.exit(0);
  } catch (error) {
    console.error(error);
    if (isCompiledApp) {
      await reportWindowsFailure(error, dataRoot, title);
    }
    process.exit(1);
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
