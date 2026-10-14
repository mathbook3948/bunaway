import { BunawayError } from "@bunaway/protocol";
import type { z } from "zod";
import type { ProcessResult, processInputSchema } from "#process/contract";
import { runWindowsProcess } from "#process/platforms/windows-process-native";

type RunInput = z.output<typeof processInputSchema>;

/** Capture one pipe while sharing a total byte budget and observing cancellation during blocked reads. */
async function capture(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  budget: {
    bytes: number;
    limit: number;
  },
) {
  signal.throwIfAborted();
  const reader = stream.getReader();
  let abort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
  });
  signal.addEventListener("abort", abort, {
    once: true,
  });
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const result = await Promise.race([
        reader.read(),
        aborted,
      ]);
      if (result.done) {
        break;
      }
      budget.bytes += result.value.byteLength;
      if (budget.bytes > budget.limit) {
        throw new BunawayError({
          code: "INTERNAL",
          message: "Process output exceeds the limit.",
        });
      }
      bytes += result.value.byteLength;
      chunks.push(result.value);
    }
    return Buffer.concat(chunks, bytes).toString("base64");
  } finally {
    signal.removeEventListener("abort", abort);
    try {
      await reader.cancel();
    } finally {
      reader.releaseLock();
    }
  }
}

/** Execute parsed argv and retain ownership until processes and pipes have been drained. */
export async function runProcess(
  input: RunInput,
  signal: AbortSignal,
): Promise<ProcessResult> {
  signal.throwIfAborted();
  if (process.platform === "win32") {
    return runWindowsProcess(input, signal);
  }
  const failure = new AbortController();
  const executionSignal = AbortSignal.any([
    signal,
    failure.signal,
  ]);
  const child = Bun.spawn(
    [
      input.executablePath,
      ...input.args,
    ],
    {
      stdin:
        input.stdinBase64 === undefined
          ? "ignore"
          : Buffer.from(input.stdinBase64, "base64"),
      stdout: "pipe",
      stderr: "pipe",
      signal: executionSignal,
      killSignal: "SIGKILL",
    },
  );
  const budget = {
    bytes: 0,
    limit: input.maxOutputBytes,
  };
  const stdout = capture(child.stdout, executionSignal, budget);
  const stderr = capture(child.stderr, executionSignal, budget);
  try {
    const [stdoutBase64, stderrBase64, exitCode] = await Promise.all([
      stdout,
      stderr,
      child.exited,
    ]);
    executionSignal.throwIfAborted();
    return {
      pid: child.pid,
      exitCode,
      signal: child.signalCode,
      stdoutBase64,
      stderrBase64,
    };
  } catch (error) {
    // A pipe failure kills the direct child and cancels its other pipe, including inherited open writers.
    failure.abort(error);
    throw error;
  } finally {
    await Promise.allSettled([
      stdout,
      stderr,
      child.exited,
    ]);
  }
}
