import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { readDevSettings, readProjectSettings } from "../../packages/cli/src/config.ts";
import { writeJson } from "../../packages/cli/src/files.ts";

test("configuration diagnostics identify the file, field and expected value", async () => {
  expect(() => readDevSettings(null)).toThrow("bunaway.json: dev must be an object");
  expect(() => readDevSettings({ command: [] })).toThrow("bunaway.json: dev.command");
  expect(() => readDevSettings({ timeout: 10 })).toThrow("unknown field dev.timeout");
  const root = await mkdtemp(resolve(tmpdir(), "bunaway-config-diagnostics-"));
  try {
    await mkdir(resolve(root, "src-bunaway"));
    for (const [build, message] of [
      [null, "build must be an object"],
      [{ typo: true }, "unknown field build.typo"],
    ] as const) {
      await writeJson(resolve(root, "src-bunaway/bunaway.json"), { version: 1, build, app: {} });
      await expect(readProjectSettings(root)).rejects.toThrow(`bunaway.json: ${message}`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
