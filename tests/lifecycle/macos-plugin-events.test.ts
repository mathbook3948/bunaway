import { expect, test } from "bun:test";
import { resolve } from "node:path";

/** Runs the fixture in its own process because it replaces the AppKit modules globally. */
async function runFixture() {
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      resolve(import.meta.dir, "fixtures/macos-plugin-events.fixture.ts"),
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
      timeout: 15000,
    },
  );
  const [output, errors, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(code, `${output}\n${errors}`).toBe(0);
  return JSON.parse(output);
}

test("a macOS plugin event reaches only the views that subscribed and stops at shutdown", async () => {
  const result = await runFixture();
  expect(result.whileRunning).toEqual([
    {
      to: "a",
      payload: {
        count: 1,
      },
    },
  ]);
  expect(result.whileStopping).toEqual([]);
});
