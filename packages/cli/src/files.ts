import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const frameworkRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export async function json(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error(`Cannot read JSON: ${path}`);
  }
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export async function projectPath(root: string, name: string): Promise<string> {
  if (!name || isAbsolute(name) || name.split(/[\\/]/).some((part) => part === "..")) {
    throw new Error("Source paths must be project-relative without '..'.");
  }
  const path = await realpath(resolve(root, name));
  if (!inside(await realpath(root), path)) throw new Error("Source path escapes the project.");
  return path;
}

export async function files(
  root: string,
  excludedDirectories: readonly string[] = [],
): Promise<string[]> {
  const result: string[] = [];
  async function visit(dir: string): Promise<void> {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      const path = resolve(dir, item.name);
      if (
        item.isDirectory() &&
        excludedDirectories.includes(relative(root, path).replaceAll("\\", "/"))
      ) {
        continue;
      }
      if ((await lstat(path)).isSymbolicLink()) throw new Error(`Symlink not allowed: ${path}`);
      if (item.isDirectory()) await visit(path);
      else if (item.isFile()) result.push(path);
      else throw new Error(`Not a regular source file: ${path}`);
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

export async function verifyHash(path: string, expected: string): Promise<void> {
  if ((await hash(path)) !== expected) throw new Error(`Hash mismatch: ${path}`);
}

export async function run(
  args: string[],
  cwd: string,
  env: Record<string, string> = {},
): Promise<void> {
  const child = Bun.spawn(args, {
    cwd,
    env: { ...process.env, ...env },
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await child.exited;
  if (code !== 0) throw new Error(`${args[0]} failed (exit ${code}).`);
}

export async function runWorker(
  module: string,
  method: string,
  args: unknown[],
  cwd: string,
): Promise<void> {
  const url = pathToFileURL(resolve(frameworkRoot, "packages/cli/src", module)).href;
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `const task = await import(${JSON.stringify(url)}); await task[${JSON.stringify(method)}](...${JSON.stringify(args)});`,
    ],
    { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  const output = new Response(child.stdout).text();
  const errors = new Response(child.stderr).text();
  const code = await child.exited;
  await output;
  if (code !== 0) throw new Error((await errors) || `${method} failed (exit ${code}).`);
  await errors;
}
