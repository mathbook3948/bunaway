import { lstat, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { acquireBuildOutputLock, ownedDirectory } from "@bunaway/packaging";
import { outputPaths } from "@bunaway/packaging/paths";
import { API_LIMITS, MAX_MESSAGE_BYTES } from "@bunaway/protocol";
import { json } from "./files.ts";

type MobileTarget = "android" | "ios";

const mobileLabels = {
  android: "Android",
  ios: "iOS",
};

/** Reject existing unrelated projects and linked marker files before touching their contents. */
export async function mobileProjectExists(
  root: string,
  target: MobileTarget,
): Promise<boolean> {
  const directory = resolve(root, target);
  if (!(await ownedDirectory(root, directory))) {
    return false;
  }
  const marker = resolve(directory, "bunaway-project.json");
  const entry = await lstat(marker).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") {
      throw error;
    }
    return undefined;
  });
  if (!entry?.isFile() || entry.isSymbolicLink()) {
    throw new Error(
      `Existing ${target} directory is not a bunaway project; refusing to overwrite it.`,
    );
  }
  const value = await json(marker);
  if (
    typeof value !== "object" ||
    value === null ||
    !("format" in value) ||
    value.format !== 1
  ) {
    throw new Error(`Unsupported ${mobileLabels[target]} project format.`);
  }
  await ownedDirectory(root, resolve(directory, ".bunaway"));
  return true;
}

/** Owns mobile output locking, signal cancellation and staging cleanup through publication and launch. */
export async function withMobileBuild<T>(
  root: string,
  target: MobileTarget,
  prepare: (staging: string, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const abort = new AbortController();
  const interrupted = () =>
    abort.abort(new Error(`${mobileLabels[target]} build cancelled.`));
  process.on("SIGINT", interrupted);
  process.on("SIGTERM", interrupted);
  let release: (() => Promise<void>) | undefined;
  const staging = resolve(outputPaths(root, target).work, crypto.randomUUID());
  try {
    release = await acquireBuildOutputLock(root, target);
    abort.signal.throwIfAborted();
    await ownedDirectory(root, staging, true);
    return await prepare(staging, abort.signal);
  } finally {
    try {
      await ownedDirectory(root, staging);
      await rm(staging, {
        recursive: true,
        force: true,
      });
    } finally {
      try {
        await release?.();
      } finally {
        process.off("SIGINT", interrupted);
        process.off("SIGTERM", interrupted);
      }
    }
  }
}

/** Combines the shared transport with its native adapter into one document-start script. */
export async function mobileBridge(
  root: string,
  target: MobileTarget,
): Promise<string> {
  const result = await Bun.build({
    entrypoints: [
      resolve(root, `native/${target}/bridge.js`),
    ],
    target: "browser",
    format: "iife",
  });
  const output = result.outputs[0];
  if (!result.success || !output || result.outputs.length !== 1) {
    throw new AggregateError(result.logs, "Could not build the mobile bridge.");
  }
  return (await output.text())
    .replaceAll("__BUNAWAY_MAX_PENDING__", String(API_LIMITS.maxPending))
    .replaceAll("__BUNAWAY_MAX_MESSAGE_BYTES__", String(MAX_MESSAGE_BYTES));
}
