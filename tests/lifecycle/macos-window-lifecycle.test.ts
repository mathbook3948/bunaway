import { expect, test } from "bun:test";
import { resolve } from "node:path";

/** Runs the fixture in its own process because it replaces the AppKit modules globally. */
async function runFixture(mode: "quit" | "keep-alive" | "reopen-failure") {
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      resolve(import.meta.dir, "fixtures/macos-window-lifecycle.fixture.ts"),
      mode,
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

test("macOS close request, lifecycle events and last-window quit follow the shared close order", async () => {
  const result = await runFixture("quit");
  // The asked document is the closing window's own, and a denial leaves the window open.
  expect(result.afterDeny).toEqual({
    requests: [
      [
        "a",
        1,
      ],
    ],
    closed: false,
  });
  // A second request is not sent while one is pending; the public close and a recreation report BUSY
  // and an answer to the earlier request is rejected.
  expect(result.whilePending).toEqual({
    requests: 2,
    publicClose: "BUSY",
    recreate: "BUSY",
    stale: "INVALID_ARGUMENT",
  });
  // Allowing the only window asks the app to quit and keeps the window while the app decides.
  expect(result.afterAllow).toEqual({
    closed: false,
    quitRequests: [
      "last-window",
    ],
    quitPending: true,
  });
  // A veto lets the next close ask again.
  expect(result.afterVeto).toEqual({
    requests: 3,
    quitRequests: [
      "last-window",
      "last-window",
    ],
    closed: false,
  });
  // The backend feed sees closed, destroyed, then the replacement's created and ready, in order.
  expect(result.lifecycle).toEqual([
    "a:created",
    "a:closed",
    "a:destroyed",
    "a:created",
    "a:ready",
  ]);
  expect(result.windowLifetimes).toEqual([
    "old",
    "old",
    "old",
    "new",
    "new",
  ]);
  // Recreation bypasses the quit check.
  expect(result.afterRecreate).toEqual({
    quitRequests: [
      "last-window",
      "last-window",
    ],
    closed: false,
  });
  expect(result.windowsGone).toBe(0);
});

test("macOS keep-alive closes the last window without a quit request and reports an empty app once per transition", async () => {
  const result = await runFixture("keep-alive");
  expect(result.afterClose).toEqual({
    aClosed: true,
    windowsEmpty: 1,
    quitRequests: [],
    windowsGone: 0,
  });
  // Showing creates the window again, and closing it empties the app again.
  expect(result.afterShow).toEqual({
    aClosed: false,
  });
  expect(result.afterSecondEmpty).toEqual({
    windowsEmpty: 2,
  });
});

test("macOS Dock reopen that cannot create its window logs the failure, keeps the app and retries on the next reopen", async () => {
  const result = await runFixture("reopen-failure");
  expect(result.afterFailedReopen).toEqual({
    failures: [],
    logged: [
      {
        event: "reopen-window-creation-failed",
        view: "a",
        code: "INTERNAL",
      },
    ],
    windowsGone: 0,
    aClosed: true,
  });
  // The consumed request is not retried by later ticks.
  expect(result.afterIdleTicks).toEqual({
    aClosed: true,
  });
  expect(result.afterNextReopen).toEqual({
    failures: [],
    aClosed: false,
  });
});
