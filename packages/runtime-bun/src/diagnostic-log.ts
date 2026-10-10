import { appendFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { API_LIMITS } from "@bunaway/protocol";

/** Writes ordered JSONL diagnostics and keeps one rotated copy of the previous log. */
export class DiagnosticLog {
  private writer = Promise.resolve();
  private queued = 0;
  constructor(private readonly path: string) {}

  /** Queue a record in call order; reject when the queue is full or the file write fails. */
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
    // Keep the chain usable after one failed write; that failure still reaches its caller.
    const writer = this.writer.then(async () => {
      try {
        await mkdir(dirname(this.path), {
          recursive: true,
        });
        try {
          if ((await stat(this.path)).size > 1024 * 1024) {
            // Keep only one archive before moving the current log out of the way.
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

  /** Wait until queued writes finish; each write caller observes its own I/O error. */
  drain() {
    return this.writer;
  }
}
