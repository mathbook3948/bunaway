import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { frameworkRoot } from "./files.ts";

export async function run(
  args: string[],
  cwd: string,
  env: Record<string, string> = {},
): Promise<void> {
  const child = Bun.spawn(args, {
    cwd,
    env: {
      ...process.env,
      ...env,
    },
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await child.exited;
  if (code !== 0) {
    throw new Error(`${args[0]} failed (exit ${code}).`);
  }
}

export async function runWorker(
  module: string,
  method: string,
  args: unknown[],
  cwd: string,
  root = frameworkRoot,
): Promise<string> {
  const url = pathToFileURL(resolve(root, "packages/cli/src", module)).href;
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `const task = await import(${JSON.stringify(url)}); const result = await task[${JSON.stringify(method)}](...await Bun.stdin.json()); if (result !== undefined) process.stdout.write(JSON.stringify(result));`,
    ],
    {
      cwd,
      stdin: Buffer.from(JSON.stringify(args)),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const output = new Response(child.stdout).text();
  const errors = new Response(child.stderr).text();
  const code = await child.exited;
  await output;
  if (code !== 0) {
    throw new Error((await errors) || `${method} failed (exit ${code}).`);
  }
  await errors;
  return output;
}
