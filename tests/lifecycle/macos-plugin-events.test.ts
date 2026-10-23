import { expect, setDefaultTimeout, test } from "bun:test";
import { resolve } from "node:path";
import { deadline, killAfter } from "../fixtures/deadlines.ts";

setDefaultTimeout(deadline("childStep"));

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
    },
  );
  const timer = killAfter(child, "childStep");
  let output: string;
  let errors: string;
  let code: number;
  try {
    [output, errors, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
  } finally {
    clearTimeout(timer);
  }
  expect(code, `${output}\n${errors}`).toBe(0);
  return JSON.parse(output);
}

test("a macOS plugin event reaches subscribed and subscribing views only and stops at shutdown", async () => {
  const result = await runFixture();
  // View a confirmed its subscription, b still awaits the answer, c never asked.
  expect(result.whileRunning).toEqual([
    {
      to: "a",
      payload: {
        count: 1,
      },
    },
    {
      to: "b",
      payload: {
        count: 1,
      },
    },
  ]);
  expect(result.whileStopping).toEqual([]);
});

test("a macOS plugin event with a required operation also needs the view's host permission", async () => {
  const result = await runFixture();
  // Only a holds both the subscription and the grant; b is pending without the grant, c lacks a subscription.
  expect(result.withGrant).toEqual([
    {
      to: "a",
      payload: {
        count: 3,
      },
    },
  ]);
  expect(result.unknownOperation).toEqual([]);
});
