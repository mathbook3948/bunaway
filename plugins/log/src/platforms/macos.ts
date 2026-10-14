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

/** Write host-attributed JSONL records on the owning I/O worker and retain one archive. */
export function write(dataRoot: string, input: LogInput, source: string): null {
  const directory = resolve(dataRoot, "logs");
  const path = resolve(directory, "app.log");
  const { level, message, details } = input;
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
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
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
}
