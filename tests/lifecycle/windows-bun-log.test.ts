import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DiagnosticLog } from "../../packages/runtime-bun/src/diagnostic-log.ts";

test("Windows diagnostic writes recover after a failed command error log", async () => {
  const home = await mkdtemp(resolve(tmpdir(), "bunaway-diagnostic-log-"));
  const path = resolve(home, "host.log");
  const log = new DiagnosticLog(path);
  try {
    // A directory at the log path forces the first append to fail.
    await mkdir(path);
    await expect(
      log.write("command-failed", {
        command: "notes.read",
      }),
    ).rejects.toThrow();
    await log.drain();
    await rmdir(path);
    await Promise.all([
      log.write("renderer-ready"),
      log.write("host-stopped"),
    ]);
    await log.drain();
    const records = (await Bun.file(path).text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(records.map((record) => record.event)).toEqual([
      "renderer-ready",
      "host-stopped",
    ]);
  } finally {
    await log.drain().catch(() => {});
    await rm(home, {
      recursive: true,
      force: true,
    });
  }
});
