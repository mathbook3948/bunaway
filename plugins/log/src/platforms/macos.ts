import {
  appendFileSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { resolve } from "node:path";
import {
  BunawayError,
  type JsonValue,
  type NativeAdapter,
  type NativeEnvironment,
} from "@bunaway/plugin";
import type { LogInput } from "../contract.ts";

const LOG_ROTATION_THRESHOLD_BYTES = 1024 * 1024;

/** Write host-attributed JSONL records on the owning I/O worker and retain one archive. */
export function createOperations(
  environment: NativeEnvironment,
): NativeAdapter {
  const directory = resolve(environment.dataRoot, "logs");
  const path = resolve(directory, "app.log");
  let disposed = false;
  return {
    execute(_operation: string, input: JsonValue, source: string): null {
      if (disposed) {
        throw new BunawayError({
          code: "CANCELLED",
          message: "Log adapter is disposed.",
        });
      }
      // The SDK has parsed the input. Attribution always comes from the host.
      const { level, message, details } = input as LogInput;
      const text = `${JSON.stringify({
        t: Date.now(),
        source,
        level,
        message,
        ...(details === undefined
          ? {}
          : {
              details,
            }),
      })}\n`;
      mkdirSync(directory, {
        recursive: true,
        mode: 0o700,
      });
      let size = 0;
      try {
        size = statSync(path).size;
      } catch (error) {
        // Only an absent active file is normal. Rotation and append errors reach the caller.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
      // Synchronous execution keeps rotation and append indivisible on this worker.
      // The protocol bounds each input; each retained file can exceed 1 MiB by at most one record.
      if (size > LOG_ROTATION_THRESHOLD_BYTES) {
        rmSync(`${path}.1`, {
          force: true,
        });
        renameSync(path, `${path}.1`);
      }
      appendFileSync(path, text, {
        mode: 0o600,
      });
      return null;
    },
    dispose() {
      // Writes close their own descriptors before returning, so no drain or open file remains.
      disposed = true;
    },
  };
}
