import type { z } from "zod";
import type { macosProcessInputSchema, ProcessResult } from "#process/contract";
import type { initialize } from "#process/platforms/foreground";
import { runForeground } from "#process/platforms/foreground";
import { runSpawnedProcess } from "#process/platforms/spawned-process";

export { dispose, initialize } from "#process/platforms/foreground";

/**
 * The adapter runs in the host process, whose environment is not the reduced one the backend
 * worker receives. The child gets only the backend's PATH so host variables never reach it.
 */
const MACOS_CHILD_ENV = {
  PATH: "/usr/bin:/bin",
};

/** Run one macOS invocation with Bun.spawn; only the direct child is terminated on cancellation. */
export function run(
  state: ReturnType<typeof initialize>,
  payload: z.output<typeof macosProcessInputSchema>,
  requestSignal?: AbortSignal,
): Promise<ProcessResult> {
  return runForeground(
    state,
    payload,
    (input, signal) => runSpawnedProcess(input, signal, MACOS_CHILD_ENV),
    () => false,
    requestSignal,
  );
}
