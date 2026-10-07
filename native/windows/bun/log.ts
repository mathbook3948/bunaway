import { appendFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { API_LIMITS } from "../../../packages/protocol/src/index.ts";

export class DiagnosticLog {
  private writer = Promise.resolve();
  private queued = 0;
  constructor(private readonly path: string) {}
  write(event: string, fields: object = {}) {
    if (this.queued >= API_LIMITS.maxPending) {
      return Promise.reject(new Error("Diagnostic queue full"));
    }
    const text = `${JSON.stringify({
      t: Date.now(),
      event,
      ...fields,
    })}\n`;
    this.queued++;
    const writer = this.writer.then(async () => {
      try {
        await mkdir(dirname(this.path), {
          recursive: true,
        });
        try {
          if ((await stat(this.path)).size > 1024 * 1024) {
            await rm(`${this.path}.1`, {
              force: true,
            });
            await rename(this.path, `${this.path}.1`);
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw error;
          }
        }
        await appendFile(this.path, text);
      } finally {
        this.queued--;
      }
    });
    this.writer = writer.catch(() => {});
    return writer;
  }
  drain() {
    return this.writer;
  }
}
