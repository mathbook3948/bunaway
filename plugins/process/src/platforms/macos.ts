import { BunawayError } from "@bunaway/protocol";
import type { z } from "zod";
import type {
  macosProcessInputSchema,
  ProcessInstance,
  ProcessResult,
} from "#process/contract";
import {
  initialize as initializeForeground,
  runForeground,
} from "#process/platforms/foreground";
import { runSpawnedProcess } from "#process/platforms/spawned-process";

export { dispose } from "#process/platforms/foreground";

/** macOS declares no spawn operations, so the handle table never launches anything. */
export function initialize(): ProcessInstance {
  return initializeForeground(() =>
    Promise.reject(
      new BunawayError({
        code: "UNSUPPORTED",
        message: "Spawned processes are not supported on macOS.",
      }),
    ),
  );
}

/**
 * The adapter runs in the host process, whose environment is not the reduced one the backend
 * worker receives. The child gets only the backend's PATH so host variables never reach it.
 */
const MACOS_CHILD_ENV = {
  PATH: "/usr/bin:/bin",
};

/** Run one macOS invocation with Bun.spawn; only the direct child is terminated on cancellation. */
export function run(
  state: ProcessInstance,
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
