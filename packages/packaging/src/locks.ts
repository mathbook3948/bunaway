import { lstat, open, readdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { BuildTarget } from "./contract.ts";
import { ownedDirectory } from "./directories.ts";
import { OUTPUT_TARGETS, type OutputTarget, outputPaths } from "./paths.ts";

/** Names the conflicting lock or directory that prevented an operation. */
export class TargetLockError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(message);
  }
}

function lockDirectory(root: string, target: OutputTarget): string {
  if (!OUTPUT_TARGETS.includes(target)) {
    throw new Error(`Unsupported build target: ${target}`);
  }
  return outputPaths(root, target).locks;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function createLock(
  root: string,
  path: string,
): Promise<() => Promise<void>> {
  const file = await open(path, "wx");
  return async () => {
    try {
      await file.close();
    } finally {
      if (await ownedDirectory(root, dirname(path))) {
        await rm(path, {
          force: true,
        });
      }
    }
  };
}

/**
 * Registers a package reader for a build target and refuses to overlap a
 * rebuild. The returned async function releases the reader lock and must be
 * awaited after the artifact is no longer in use.
 */
export async function acquirePackageInputLock(
  root: string,
  target: BuildTarget,
): Promise<() => Promise<void>> {
  const directory = lockDirectory(root, target);
  await ownedDirectory(root, directory, true);
  const build = resolve(directory, "build.lock");
  if (await exists(build)) {
    throw new TargetLockError(
      build,
      `Build target ${target} is locked by a rebuild.`,
    );
  }
  const release = await createLock(
    root,
    resolve(directory, `package-${crypto.randomUUID()}.lock`),
  );
  // Recheck after registering: a builder may have acquired its lock during registration.
  try {
    if (await exists(build)) {
      throw new TargetLockError(
        build,
        `Build target ${target} is locked by a rebuild.`,
      );
    }
  } catch (error) {
    await release();
    throw error;
  }
  return release;
}

/**
 * Locks a build output and refuses to start while any package reader is active.
 * The returned async function releases the lock and must be awaited after the
 * build has finished.
 */
export async function acquireBuildOutputLock(
  root: string,
  target: OutputTarget,
): Promise<() => Promise<void>> {
  const directory = lockDirectory(root, target);
  await ownedDirectory(root, directory, true);
  const build = resolve(directory, "build.lock");
  let release: () => Promise<void>;
  try {
    release = await createLock(root, build);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
    throw new TargetLockError(
      build,
      `Build target ${target} is locked by another rebuild.`,
    );
  }
  // Readers register before checking build.lock; either side observes the other and refuses.
  try {
    if (
      (await readdir(directory)).some((name) => name.startsWith("package-"))
    ) {
      throw new TargetLockError(
        directory,
        `Build target ${target} is in use by packaging.`,
      );
    }
  } catch (error) {
    await release();
    throw error;
  }
  return release;
}
