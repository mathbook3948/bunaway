import type { z } from "zod";
import type { ProcessResult, processInputSchema } from "#process/contract";
import type { initialize } from "#process/platforms/foreground";
import { runForeground } from "#process/platforms/foreground";
import { runProcess } from "#process/platforms/windows-process";
import { ProcessCleanupError } from "#process/platforms/windows-process-native";

export { dispose, initialize } from "#process/platforms/foreground";

/** Run one Windows invocation; native cleanup failures keep their own error. */
export function run(
  state: ReturnType<typeof initialize>,
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
