import { createHash } from "node:crypto";
import {
  lstat,
  readdir,
  readFile,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const frameworkRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

export interface PackageDependencies {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<
    string,
    {
      optional?: boolean;
    }
  >;
}

export function isOptionalDependency(
  pkg: PackageDependencies,
  name: string,
): boolean {
  return (
    Object.hasOwn(pkg.optionalDependencies ?? {}, name) ||
    (!Object.hasOwn(pkg.dependencies ?? {}, name) &&
      !Object.hasOwn(pkg.devDependencies ?? {}, name) &&
      pkg.peerDependenciesMeta?.[name]?.optional === true)
  );
}

/** Resolve an installed dependency from the project or one of its parent directories. */
export async function installedPackageRoot(
  project: string,
  name: string,
  canonical = true,
): Promise<string> {
  let parent = resolve(project);
  while (true) {
    const candidate = resolve(parent, "node_modules", name);
    try {
      await stat(resolve(candidate, "package.json"));
      return canonical ? await realpath(candidate) : candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    const next = dirname(parent);
    if (next === parent) {
      throw Object.assign(
        new Error(`Missing installed ${name}; run bun install.`),
        {
          code: "ENOENT",
        },
      );
    }
    parent = next;
  }
}

/** Read JSON and add the file path to parse or I/O failures. */
export async function json(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (cause) {
    throw new Error(`Cannot read JSON: ${path}`, {
      cause,
    });
  }
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** Resolve a project-relative source path, rejecting parent segments and links that escape the project. */
export async function projectPath(root: string, name: string): Promise<string> {
  if (
    !name ||
    isAbsolute(name) ||
    name.split(/[\\/]/).some((part) => part === "..")
  ) {
    throw new Error("Source paths must be project-relative without '..'.");
  }
  const path = await realpath(resolve(root, name));
  if (!inside(await realpath(root), path)) {
    throw new Error("Source path escapes the project.");
  }
  return path;
}

/** List regular files in stable order, rejecting links and special files. */
export async function files(
  root: string,
  excludedDirectories: readonly string[] = [],
): Promise<string[]> {
  const result: string[] = [];
  async function visit(dir: string): Promise<void> {
    for (const item of await readdir(dir, {
      withFileTypes: true,
    })) {
      const path = resolve(dir, item.name);
      if (
        item.isDirectory() &&
        excludedDirectories.includes(relative(root, path).replaceAll("\\", "/"))
      ) {
        continue;
      }
      if ((await lstat(path)).isSymbolicLink()) {
        throw new Error(`Symlink not allowed: ${path}`);
      }
      if (item.isDirectory()) {
        await visit(path);
      } else if (item.isFile()) {
        result.push(path);
      } else {
        throw new Error(`Not a regular source file: ${path}`);
      }
    }
  }
  await visit(root);
  return result.sort();
}

export async function hash(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

/** Throw when a file's SHA-256 digest does not match the recorded value. */
export async function verifyHash(
  path: string,
  expected: string,
): Promise<void> {
  if ((await hash(path)) !== expected) {
    throw new Error(`Hash mismatch: ${path}`);
  }
}
