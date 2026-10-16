import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";

export interface ToolResult {
  code: number;
  stdout: string;
  stderr: string;
}

type ToolOptions = {
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** Capture through owned temporary regular files when a tool's helpers cannot use pipes. */
  captureDirectory?: string;
};

/** Returns trimmed output and the exit code; owns capture-file cleanup, including spawn failures. */
export async function run(
  exe: string,
  args: string[],
  options: ToolOptions = {},
): Promise<ToolResult> {
  const directory = options.captureDirectory
    ? await mkdtemp(resolve(options.captureDirectory, "tool-output."))
    : undefined;
  try {
    const stdoutFile = directory
      ? Bun.file(resolve(directory, "stdout"))
      : undefined;
    const stderrFile = directory
      ? Bun.file(resolve(directory, "stderr"))
      : undefined;
    const proc = Bun.spawn(
      [
        exe,
        ...args,
      ],
      {
        ...(options.cwd !== undefined
          ? {
              cwd: options.cwd,
            }
          : {}),
        ...(options.env !== undefined
          ? {
              env: options.env,
            }
          : {}),
        stdout: stdoutFile ?? "pipe",
        stderr: stderrFile ?? "pipe",
      },
    );
    // Regular files must be read after the tool finishes; pipe readers must drain while it runs.
    if (stdoutFile && stderrFile) {
      const code = await proc.exited;
      const [stdout, stderr] = await Promise.all([
        stdoutFile.text(),
        stderrFile.text(),
      ]);
      return {
        code,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      };
    }
    // With file capture absent, both outputs were requested as pipes. Bun's union also includes FDs.
    assert(typeof proc.stdout !== "number" && typeof proc.stderr !== "number");
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return {
      code,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
    };
  } finally {
    if (directory) {
      await rm(directory, {
        recursive: true,
        force: true,
      });
    }
  }
}

/** Throws on a nonzero exit, including captured output in the error when available. */
export async function must(
  exe: string,
  args: string[],
  options: ToolOptions = {},
): Promise<ToolResult> {
  const result = await run(exe, args, options);
  if (result.code !== 0) {
    throw toolFailure(exe, result);
  }
  return result;
}

/** Builds the error `must` throws for a nonzero exit, so callers with custom handling report identically. */
export function toolFailure(exe: string, result: ToolResult): Error {
  const detail = (result.stderr || result.stdout).slice(0, 2000);
  return new Error(
    `${basenameOf(exe)} exited ${result.code}${detail ? `: ${detail}` : ""}`,
  );
}

function basenameOf(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}
