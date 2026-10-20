import type { z } from "zod";
import type {
  ProcessResult,
  processInputSchema,
  spawnInputSchema,
} from "#process/contract";
import { launchBunChild } from "#process/platforms/bun-child";
import type { SpawnedChild } from "#process/platforms/spawn-child";
import { runSpawnedProcess } from "#process/platforms/spawned-process";
import { WindowsProcessChild } from "#process/platforms/windows-child";
import { runWindowsProcess } from "#process/platforms/windows-process-native";

type RunInput = z.output<typeof processInputSchema>;
type SpawnInput = z.output<typeof spawnInputSchema>;

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

/** Start a long-running child: a Job-contained Win32 process on Windows, a Bun.spawn child elsewhere. */
export async function launchProcess(
  input: SpawnInput,
  signal: AbortSignal,
): Promise<SpawnedChild> {
  signal.throwIfAborted();
  if (process.platform === "win32") {
    return WindowsProcessChild.launch(
      {
        executablePath: input.executablePath,
        args: input.args,
        stdin: "pipe",
      },
      signal,
    );
  }
  return launchBunChild(input);
}
