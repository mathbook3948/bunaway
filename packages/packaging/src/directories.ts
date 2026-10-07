import { lstat, mkdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

// Owned output/lock directories cannot be redirected through links. Read-only
// inputs and links inside a published package have separate validation rules.
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
