import type { z } from "zod";
import type { ProcessResult, processInputSchema } from "#process/contract";
import { runSpawnedProcess } from "#process/platforms/spawned-process";
import { runWindowsProcess } from "#process/platforms/windows-process-native";

type RunInput = z.output<typeof processInputSchema>;

/** Execute parsed argv: Win32 CreateProcess on Windows, Bun.spawn elsewhere. */
export async function runProcess(
  input: RunInput,
  signal: AbortSignal,
): Promise<ProcessResult> {
  signal.throwIfAborted();
  if (process.platform === "win32") {
    return runWindowsProcess(input, signal);
  }
  return runSpawnedProcess(input, signal);
}
