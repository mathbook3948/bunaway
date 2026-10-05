import { lstat, mkdir, open, readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import type { BuildTarget } from "./contract.ts";

export class TargetLockError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(message);
  }
}

function lockDirectory(root: string, target: BuildTarget): string {
  return resolve(root, "dist", ".bunaway-locks", target);
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function createLock(path: string): Promise<() => Promise<void>> {
  const file = await open(path, "wx");
  return async () => {
    try {
      await file.close();
    } finally {
      await rm(path, { force: true });
    }
  };
}

export async function acquirePackageInputLock(
  root: string,
  target: BuildTarget,
): Promise<() => Promise<void>> {
  const directory = lockDirectory(root, target);
  await mkdir(directory, { recursive: true });
  const build = resolve(directory, "build.lock");
  if (await exists(build)) {
    throw new TargetLockError(build, `Build target ${target} is locked by a rebuild.`);
  }
  const release = await createLock(resolve(directory, `package-${crypto.randomUUID()}.lock`));
  // Recheck after registering: a builder may have acquired its lock during registration.
  try {
    if (await exists(build)) {
      throw new TargetLockError(build, `Build target ${target} is locked by a rebuild.`);
    }
  } catch (error) {
    await release();
    throw error;
  }
  return release;
}

export async function acquireBuildOutputLock(
  root: string,
  target: BuildTarget,
): Promise<() => Promise<void>> {
  const directory = lockDirectory(root, target);
  await mkdir(directory, { recursive: true });
  const build = resolve(directory, "build.lock");
  let release: () => Promise<void>;
  try {
    release = await createLock(build);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    throw new TargetLockError(build, `Build target ${target} is locked by another rebuild.`);
  }
  // Readers register before checking build.lock; either side observes the other and refuses.
  try {
    if ((await readdir(directory)).some((name) => name.startsWith("package-"))) {
      throw new TargetLockError(directory, `Build target ${target} is in use by packaging.`);
    }
  } catch (error) {
    await release();
    throw error;
  }
  return release;
}
