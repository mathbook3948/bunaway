import type { z } from "zod";
import type {
  ProcessInstance,
  ProcessResult,
  processInputSchema,
} from "#process/contract";
import {
  initialize as initializeForeground,
  runForeground,
} from "#process/platforms/foreground";
import { launchProcess, runProcess } from "#process/platforms/windows-process";
import { ProcessCleanupError } from "#process/platforms/windows-process-native";

export { dispose } from "#process/platforms/foreground";

/** Own foreground invocations and spawned children; spawned children are Job-contained Win32 processes. */
export function initialize(): ProcessInstance {
  return initializeForeground(launchProcess);
}

/** Run one Windows invocation; native cleanup failures keep their own error. */
export function run(
  state: ProcessInstance,
  payload: z.output<typeof processInputSchema>,
  requestSignal?: AbortSignal,
): Promise<ProcessResult> {
  return runForeground(
    state,
    payload,
    runProcess,
    (error) => error instanceof ProcessCleanupError,
    requestSignal,
  );
}
