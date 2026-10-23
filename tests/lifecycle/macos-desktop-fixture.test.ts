import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { desktopFixturePath } from "../fixtures/macos-desktop/fixture-config.ts";
import { deadline } from "../fixtures/deadlines.ts";

setDefaultTimeout(deadline("toolchain"));

/**
 * Contract test of the backend side of the real-AppKit fixture (tests/fixtures/macos-desktop/app.ts)
 * on every platform. The fixture app runs in a subprocess on a real Core and DesktopLifecycle, the
 * way native/macos/bun/backend.ts drives them, while a fake host answers the Host calls. It proves
 * that the scenario script starts from the plugin setup scope, reaches the `driver` plugin from the
 * backend context, and reports a failed host call with its code and details. The AppKit side of the
 * driver is covered by tests/lifecycle/macos-desktop.ts on macOS only.
 *
 * The policy is minimal and local because tests/lifecycle/macos-desktop.ts asserts macOS at import.
 */

const APP_PATH = resolve(import.meta.dir, "../fixtures/macos-desktop/app.ts");
const CORE_PATH = resolve(import.meta.dir, "../../packages/core/src/index.ts");
const DESKTOP_PATH = resolve(
  import.meta.dir,
  "../../native/windows/bun/desktop.ts",
);
const PROTOCOL_PATH = resolve(
  import.meta.dir,
  "../../packages/protocol/src/index.ts",
);
const APP_INFO_PATH = resolve(import.meta.dir, "../fixtures/app-info.ts");
const BACKEND_CONTEXT = "backend-test";
const RUN_TIMEOUT_MS = 15_000;
const STEP_TIMEOUT_MS = 5000;

/** Outcome the runner prints: every Host call the app made and the app's event log. */
type RunReport = {
  calls: {
    context: string;
    operation: string;
    payload: unknown;
  }[];
  log: string[];
};

/**
 * Subprocess body. It imports the fixture app (which reads `HOME` at import), starts a Core with a
 * fake `callHost`, and runs the desktop hooks in the order of the macOS backend: `onReady`, then
 * the initial `onOpen`. The runner then plays the pages by logging `page:main`.
 */
const RUNNER = `
import { appendFileSync, readFileSync } from "node:fs";
import { createCore } from ${JSON.stringify(CORE_PATH)};
import { testAppInfo } from ${JSON.stringify(APP_INFO_PATH)};
import { DesktopLifecycle } from ${JSON.stringify(DESKTOP_PATH)};
import { PROTOCOL_VERSION, SDK_READY_FEATURE } from ${JSON.stringify(PROTOCOL_PATH)};

const logPath = process.env.FIXTURE_LOG;
const failDrive = process.env.FAKE_DRIVE === "error";
const calls = [];
const readLog = () => readFileSync(logPath, "utf8").split("\\n").filter(Boolean);
const app = (await import(${JSON.stringify(APP_PATH)})).default;
const core = await createCore(app, {
  app: testAppInfo,
  policy: {
    version: 1,
    backend: { permissions: ["driver.drive", "windows.isOpen", "windows.getReadiness", "windows.close", "windows.recreate"] },
    views: [{ id: "main", origins: ["https://app.bunaway.local"], commands: [], events: [], host: { permissions: [] } }],
  },
  platform: "macos",
  backendContext: ${JSON.stringify(BACKEND_CONTEXT)},
  hello: { kind: "hello", protocol: PROTOCOL_VERSION, features: [SDK_READY_FEATURE], buildId: "test" },
  runtime: {
    createCancellation: () => new AbortController(),
    now: () => Date.now(),
    schedule(callback, delay) {
      const timer = setTimeout(callback, delay);
      return () => clearTimeout(timer);
    },
  },
  onCommandError: (command, cause) => console.error("Command " + command + " failed:", cause),
  onPluginError: (plugin, phase, cause) => console.error("Plugin " + plugin + " " + phase + " failed:", cause),
  async send() {},
  async callHost(context, call) {
    calls.push({ context, operation: call.operation, payload: call.payload });
    if (call.operation === "driver.drive") {
      return failDrive
        ? { kind: "error", error: { code: "INTERNAL", message: "Host operation failed.", details: { reason: "fixture" } } }
        : { kind: "result", payload: 2 };
    }
    if (call.operation === "windows.waitForLifecycle") {
      return new Promise(() => {});
    }
    return { kind: "result", payload: call.operation === "windows.isOpen" ? false : null };
  },
});
const desktop = new DesktopLifecycle(app.desktop, async () => {}, () => {}, (error) => console.error(error));
desktop.ready({ argv: [], cwd: process.cwd() });
appendFileSync(logPath, "page:main\\n");
const deadline = Date.now() + ${STEP_TIMEOUT_MS};
while (!(failDrive ? readLog().some((line) => line.startsWith("script-failed:")) : calls.some((call) => call.operation === "driver.drive"))) {
  if (Date.now() > deadline) {
    console.error("Timed out waiting for the scenario script.");
    process.exit(1);
  }
  await Bun.sleep(10);
}
console.log(JSON.stringify({ calls, log: readLog() }));
process.exit(0);
`;

/** Runs the fixture backend with a fake host whose `driver.drive` succeeds or fails. */
async function runFixtureBackend(drive: "ok" | "error"): Promise<RunReport> {
  const directory = await mkdtemp(resolve(tmpdir(), "bunaway-macos-fixture-"));
  try {
    const log = resolve(directory, "events.log");
    await Bun.write(log, "");
    await Bun.write(
      desktopFixturePath(directory),
      JSON.stringify({
        scenario: "last-window",
        events: log,
      }),
    );
    const runner = resolve(directory, "runner.ts");
    await Bun.write(runner, RUNNER);
    const child = Bun.spawn(
      [
        process.execPath,
        runner,
      ],
      {
        env: {
          ...process.env,
          HOME: directory,
          FIXTURE_LOG: log,
          FAKE_DRIVE: drive,
        },
        stdout: "pipe",
        stderr: "pipe",
        timeout: RUN_TIMEOUT_MS,
      },
    );
    const [output, errors, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code, errors).toBe(0);
    return JSON.parse(output.trim().split("\n").at(-1) ?? "");
  } finally {
    await rm(directory, {
      recursive: true,
      force: true,
    });
  }
}

test("macOS fixture scenario starts after the first open and drives the window from the backend context", async () => {
  const { calls, log } = await runFixtureBackend("ok");
  // The runner logs the page lines itself, so only the hook lines carry the order under test.
  const hooks = log.filter((line) => !line.startsWith("page:"));
  expect(hooks.slice(0, 3)).toEqual([
    "onReady",
    "onOpen:initial",
    "openArgs:0",
  ]);
  const first = calls.find((call) => call.operation === "driver.drive");
  expect(first).toEqual({
    context: BACKEND_CONTEXT,
    operation: "driver.drive",
    payload: {
      action: "close",
      title: "main",
    },
  });
});

test("macOS fixture logs the code and details of a failed host call", async () => {
  const { log } = await runFixtureBackend("error");
  const failure = log.find((line) => line.startsWith("script-failed:"));
  expect(failure).toContain("code=INTERNAL");
  expect(failure).toContain("message=Host operation failed.");
  expect(failure).toContain(
    JSON.stringify({
      reason: "fixture",
    }),
  );
  // One line, so the native test's line-based log stays parseable.
  expect(failure).not.toContain("\n");
});
