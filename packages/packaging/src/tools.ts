export interface ToolResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Returns trimmed output and the exit code; process-spawn errors still throw. */
export async function run(
  exe: string,
  args: string[],
  options: {
    cwd?: string;
    env?: Record<string, string | undefined>;
  } = {},
): Promise<ToolResult> {
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
      stdout: "pipe",
      stderr: "pipe",
    },
  );
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
}

/** Throws on a nonzero exit, including captured output in the error when available. */
export async function must(
  exe: string,
  args: string[],
  options: {
    cwd?: string;
    env?: Record<string, string | undefined>;
  } = {},
): Promise<ToolResult> {
  const result = await run(exe, args, options);
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).slice(0, 2000);
    throw new Error(
      `${basenameOf(exe)} exited ${result.code}${detail ? `: ${detail}` : ""}`,
    );
  }
  return result;
}

function basenameOf(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}
