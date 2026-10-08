import {
  appendFileSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { resolve } from "node:path";
import type {
  JsonValue,
  NativeAdapter,
  NativeEnvironment,
} from "@bunaway/plugin";
import type { LogInput } from "./index.ts";

const LOG_ROTATION_THRESHOLD_BYTES = 1024 * 1024;

export function createOperations(
  environment: NativeEnvironment,
): NativeAdapter {
  return {
    execute(_operation: string, input: JsonValue, source: string): null {
      const path = resolve(environment.dataRoot, "logs/app.log");
      mkdirSync(resolve(environment.dataRoot, "logs"), {
        recursive: true,
      });
      try {
        if (statSync(path).size > LOG_ROTATION_THRESHOLD_BYTES) {
          rmSync(`${path}.1`, {
            force: true,
          });
          renameSync(path, `${path}.1`);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
      appendFileSync(
        path,
        `${JSON.stringify({
          t: Date.now(),
          source,
          ...(input as LogInput),
        })}\n`,
      );
      return null;
    },
    dispose() {},
  };
}
