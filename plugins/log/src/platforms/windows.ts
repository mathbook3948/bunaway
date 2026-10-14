import {
  appendFileSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { resolve } from "node:path";
import type { LogInput } from "#log/contract";

const LOG_ROTATION_THRESHOLD_BYTES = 1024 * 1024;

/** Append host-approved log records and retain one rotated file. */
export function write(dataRoot: string, input: LogInput, source: string): null {
  const path = resolve(dataRoot, "logs/app.log");
  mkdirSync(resolve(dataRoot, "logs"), {
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
      ...input,
    })}\n`,
  );
  return null;
}
