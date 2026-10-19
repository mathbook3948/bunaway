import type { z } from "zod";
import type { macosProcessInputSchema, ProcessResult } from "#process/contract";
import type { initialize } from "#process/platforms/foreground";
import { runForeground } from "#process/platforms/foreground";
import { runSpawnedProcess } from "#process/platforms/spawned-process";

export { dispose, initialize } from "#process/platforms/foreground";

/** Run one macOS invocation with Bun.spawn; only the direct child is terminated on cancellation. */
export function run(
  state: ReturnType<typeof initialize>,
  payload: z.output<typeof macosProcessInputSchema>,
  requestSignal?: AbortSignal,
): Promise<ProcessResult> {
  return runForeground(
    state,
    payload,
    runSpawnedProcess,
    () => false,
    requestSignal,
  );
}
