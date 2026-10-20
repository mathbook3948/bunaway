import { BunawayError } from "@bunaway/protocol";
import type { z } from "zod";
import type { ProcessResult, processInputSchema } from "#process/contract";
import type { SpawnedChild } from "#process/platforms/spawn-child";
import { WindowsProcessChild } from "#process/platforms/windows-child";
import { POLL_INTERVAL_MS } from "#process/platforms/windows-process-constants";

export { ProcessCleanupError } from "#process/platforms/windows-child";

type RunInput = z.output<typeof processInputSchema>;

/** Write the optional input, then close stdin; a failure is handed back so the poll loop can raise it. */
async function feedInput(
  child: SpawnedChild,
  inputBytes: Buffer,
  signal: AbortSignal,
  failures: {
    error?: unknown;
  },
) {
  try {
    await child.write(inputBytes, signal);
    await child.closeStdin();
  } catch (error) {
    failures.error = error;
  }
}

/** Poll the child until it exits and both pipes end, enforcing the shared output budget. */
async function collect(
  child: SpawnedChild,
  input: RunInput,
  signal: AbortSignal,
  failures: {
    error?: unknown;
  },
): Promise<ProcessResult> {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let totalBytes = 0;
  while (true) {
    signal.throwIfAborted();
    if (failures.error !== undefined) {
      throw failures.error;
    }
    const state = child.state();
    totalBytes += state.stdoutBytes + state.stderrBytes;
    if (totalBytes > input.maxOutputBytes) {
      throw new BunawayError({
        code: "INTERNAL",
        message: "Process output exceeds the limit.",
      });
    }
    stdout.push(child.take("stdout", state.stdoutBytes));
    stderr.push(child.take("stderr", state.stderrBytes));
    if (state.exit && state.outputEnded) {
      return {
        pid: child.pid,
        exitCode: state.exit.exitCode,
        signal: state.exit.signal,
        stdoutBase64: Buffer.concat(stdout).toString("base64"),
        stderrBase64: Buffer.concat(stderr).toString("base64"),
      };
    }
    await Bun.sleep(POLL_INTERVAL_MS);
  }
}

/**
 * Run one foreground invocation to completion. The child is released on every path, and a
 * failed release takes precedence over the completion or cancellation that preceded it.
 */
export async function runWindowsProcess(
  input: RunInput,
  signal: AbortSignal,
): Promise<ProcessResult> {
  const child = await WindowsProcessChild.launch(
    {
      executablePath: input.executablePath,
      args: input.args,
      stdin: input.stdinBase64 === undefined ? "nul" : "pipe",
    },
    signal,
  );
  const failures: {
    error?: unknown;
  } = {};
  const feeding =
    input.stdinBase64 === undefined
      ? Promise.resolve()
      : feedInput(
          child,
          Buffer.from(input.stdinBase64, "base64"),
          signal,
          failures,
        );
  try {
    return await collect(child, input, signal, failures);
  } finally {
    try {
      await child.release();
    } finally {
      await feeding;
    }
  }
}
