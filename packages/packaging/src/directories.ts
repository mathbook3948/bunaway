import { lstat, mkdir, realpath, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

/**
 * Verifies each existing output path component is a real directory beneath the
 * caller-selected root, optionally creating missing components. Returns false
 * when a descendant is absent; a missing root throws unless `create` is true.
 * Throws if the path escapes or crosses a link.
 */
export async function ownedDirectory(
  root: string,
  path: string,
  create = false,
): Promise<boolean> {
  const suffix = relative(resolve(root), resolve(path));
  if (suffix === ".." || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) {
    throw new Error(`Output directory escapes the project: ${path}`);
  }
  // The caller selects the project root; locks also support a not-yet-created root.
  if (create) {
    await mkdir(root, {
      recursive: true,
    });
  }
  if (!(await lstat(root)).isDirectory()) {
    throw new Error(
      `Project root must be a regular directory without links: ${root}`,
    );
  }
  let current = await realpath(root);
  for (const component of suffix.split(sep).filter(Boolean)) {
    current = resolve(current, component);
    let entry = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") {
        throw error;
      }
      return undefined;
    });
    if (!entry && create) {
      await mkdir(current).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") {
          throw error;
        }
      });
      entry = await lstat(current);
    }
    if (!entry) {
      return false;
    }
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error(
        `Output directory must be a regular directory without links: ${current}`,
      );
    }
  }
  return true;
}

/** A publication committed successfully but its previous output could not be removed. */
export class PublishedDirectoryCleanupError extends Error {
  constructor(
    readonly backup: string,
    cause: unknown,
  ) {
    super(`Published output, but cannot remove previous directory: ${backup}`, {
      cause,
    });
  }
}

/**
 * Publish a staged owned directory, backing up and restoring prior output on failure.
 * Rejects links and missing staging. Rollback failure retains both causes and names
 * the recoverable backup. PublishedDirectoryCleanupError means the new output is
 * already committed; callers must not undo resources transferred into it.
 */
export async function publishOwnedDirectory(
  root: string,
  source: string,
  destination: string,
): Promise<void> {
  if (!(await ownedDirectory(root, source))) {
    throw new Error(`Missing publication directory: ${source}`);
  }
  await ownedDirectory(root, destination);
  await ownedDirectory(root, dirname(destination), true);
  const backup = `${destination}.previous-${crypto.randomUUID()}`;
  let previous = false;
  try {
    await rename(destination, backup);
    previous = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  try {
    await ownedDirectory(root, source);
    await rename(source, destination);
  } catch (error) {
    if (previous) {
      try {
        await ownedDirectory(root, dirname(destination));
        await rename(backup, destination);
      } catch (rollbackError) {
        throw new AggregateError(
          [
            error,
            rollbackError,
          ],
          `Publication and rollback failed; previous output remains at ${backup}`,
          {
            cause: error,
          },
        );
      }
    }
    throw error;
  }
  if (previous) {
    try {
      await ownedDirectory(root, backup);
      await rm(backup, {
        recursive: true,
        force: true,
      });
    } catch (error) {
      throw new PublishedDirectoryCleanupError(backup, error);
    }
  }
}
