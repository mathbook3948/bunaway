// Exercise CLI orchestration with real frontend processes and a small host process.
// Native WebView behavior is covered separately by the platform integration runners.
import { expect, mock } from "bun:test";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { inspect } from "node:util";
import * as build from "#cli/build";
import type { Project } from "#cli/config";
import { DevApp } from "#cli/dev-app";
import * as windowsDevLaunch from "#cli/windows-dev-launch";

const root = process.argv[2];
if (!root) {
  throw new Error("Expected a generated project.");
}
const marker = resolve(root, ".bunaway/host-starts.txt");
const close = resolve(root, ".bunaway/close-host.txt");
const host = resolve(root, ".bunaway/dev-host.ts");
const diagnostics = resolve(root, ".bunaway/dev-fixture-failure.txt");
await rm(diagnostics, {
  force: true,
});
await rm(marker, {
  force: true,
});
await rm(close, {
  force: true,
});
// Keep the host alive until the test requests shutdown and record each replacement PID.
await Bun.write(
  host,
  `
  import { appendFile } from 'node:fs/promises';
  await appendFile(${JSON.stringify(marker)}, String(process.pid) + '\\n');
  setInterval(async () => { if (await Bun.file(${JSON.stringify(close)}).exists()) process.exit(0); }, 20);
`,
);
const failureMode = process.argv[3];
let buildAttempts = 0;
let startupRepaired = failureMode !== "process-start-failure";
const repairStartup = Promise.withResolvers<void>();
let startupFailure: unknown;
if (failureMode === "process-start-failure") {
  const PlatformDevApp = DevApp;
  mock.module(import.meta.resolve("#cli/dev-app"), () => ({
    DevApp: class extends PlatformDevApp {
      override async start(
        project: Project,
        built: build.BuiltPackage,
        isCurrent: () => boolean,
      ): Promise<void> {
        try {
          await super.start(project, built, isCurrent);
        } catch (error) {
          // Observe the real platform launch failure before the controller renders it.
          // Error.toString() omits the structured code on Windows.
          startupFailure = error;
          throw error;
        }
      }
    },
  }));
}
mock.module(import.meta.resolve("#cli/build"), () => ({
  ...build,
  prepareNative: async () => ({
    target: "windows-x64",
    host: process.execPath,
    bun: process.execPath,
    licenses: {},
  }),
  buildProject: async () => {
    buildAttempts += 1;
    // Startup notifications may discard a build before it ever launches. Keep the bad
    // executable until a launch actually fails, then wait for the fixture's repair save.
    if (failureMode === "process-start-failure" && buildFailed) {
      await repairStartup.promise;
    }
    return {
      output: root,
      package: root,
      executable: startupRepaired
        ? process.execPath
        : resolve(root, ".bunaway/missing-host"),
      arguments: [
        host,
      ],
    };
  },
}));
mock.module(import.meta.resolve("#cli/windows-dev-launch"), () => ({
  ...windowsDevLaunch,
  verifyWindowsLaunch: async () => {},
  windowsLaunchEnvironment: () => process.env,
  closeWindowsApp: async (pid: number) => {
    process.kill(pid, "SIGTERM");
    return 1;
  },
}));

const { devProject } = await import("#cli/dev");
const configPath = resolve(root, "src-bunaway/bunaway.json");
const configText = await Bun.file(configPath).text();
const ui = resolve(root, "src/main.ts");
const backend = resolve(root, "src-bunaway/app.ts");
const uiText = await Bun.file(ui).text();
const backendText = await Bun.file(backend).text();
const shared = resolve(root, "shared/development-value.ts");
const sharedImport = 'import "../shared/development-value.ts";\n';
const brokenStart = [
  "broken-start",
  "broken-shared",
  "missing-shared",
].includes(failureMode ?? "");
const originalError = console.error;
let buildFailed = false;
let failureReports = 0;
let buildFailureMessage: string | undefined;
console.error = (...args: unknown[]) => {
  if (String(args[0]).includes("Dev build failed")) {
    buildFailed = true;
    failureReports += 1;
    buildFailureMessage = String(args[0]);
  }
  originalError(...args);
};
/** Chooses an available loopback port for a real server fixture. */
function settings() {
  const listener = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(""),
  });
  const port = listener.port;
  listener.stop(true);
  return {
    command: [
      process.execPath,
      resolve(import.meta.dir, "dev-server.fixture.ts"),
      String(port),
      "ready",
    ],
    url: `http://127.0.0.1:${port}/`,
    timeoutMs: 5000,
  };
}
/** Counts host launches recorded by the controlled child process. */
async function starts() {
  try {
    return (await Bun.file(marker).text()).trim().split("\n").length;
  } catch {
    return 0;
  }
}
/** Polls child-process state with a deadline so orchestration stalls cannot hang. */
async function waitFor(phase: string, check: () => Promise<boolean>) {
  const deadline = Date.now() + 10000;
  while (!(await check())) {
    if (finished || Date.now() > deadline) {
      throw new Error(
        `Development fixture ${failureMode ?? "normal"} stalled during ${phase}: ` +
          `buildAttempts=${buildAttempts}, buildFailed=${buildFailed}, ` +
          `hostStarts=${await starts()}, finished=${finished}.`,
        {
          cause: runningError,
        },
      );
    }
    await Bun.sleep(40);
  }
}
const first = settings();
let running: Promise<void> | undefined;
let finished = false;
let runningError: unknown;
try {
  await Bun.write(shared, 'console.error("shared dependency");\n');
  await Bun.write(backend, sharedImport + backendText);
  if (failureMode === "broken-start") {
    await Bun.write(backend, "export default = ;\n");
  }
  if (failureMode === "broken-shared") {
    await Bun.write(shared, "export const invalid = ;\n");
  }
  if (failureMode === "missing-shared") {
    await rm(shared);
  }
  await Bun.write(
    configPath,
    JSON.stringify({
      ...JSON.parse(configText),
      dev: first,
    }),
  );
  running = devProject(root);
  void running.then(
    () => {
      finished = true;
    },
    (error) => {
      finished = true;
      runningError = error;
    },
  );
  if (brokenStart || failureMode === "process-start-failure") {
    await waitFor("initial failure report", async () => buildFailed);
    expect(finished).toBe(false);
    expect(await starts()).toBe(0);
    if (failureMode === "process-start-failure") {
      expect(startupFailure).toMatchObject({
        code: "ENOENT",
        path: resolve(root, ".bunaway/missing-host"),
      });
      expect(buildFailureMessage).toContain("missing-host");
      expect(failureReports).toBe(1);
      expect((await fetch(first.url)).ok).toBe(true);
    } else {
      await expect(fetch(first.url)).rejects.toThrow();
    }
    if (failureMode === "broken-start") {
      await Bun.write(backend, sharedImport + backendText);
    } else {
      await Bun.write(shared, 'console.error("repaired shared dependency");\n');
    }
    startupRepaired = true;
    repairStartup.resolve();
  }
  await waitFor(
    "initial/recovered app launch",
    async () => (await starts()) === 1,
  );
  // UI edits stay in Vite's HMR loop; backend edits replace the native host.
  await Bun.write(ui, `${uiText}\n// frontend update\n`);
  await Bun.sleep(350);
  expect(await starts()).toBe(1);
  await Bun.write(
    backend,
    `${sharedImport}${backendText}\n// backend update\n`,
  );
  await waitFor("backend edit restart", async () => (await starts()) === 2);
  expect((await fetch(first.url)).ok).toBe(true);
  await Bun.write(shared, 'console.error("updated shared dependency");\n');
  await waitFor(
    "shared dependency restart",
    async () => (await starts()) === 3,
  );
  expect((await fetch(first.url)).ok).toBe(true);
  // Keep the first server bound while choosing its replacement so the OS cannot
  // reuse its port and accidentally turn reconfiguration into unchanged settings.
  const second = settings();
  expect(second.url).not.toBe(first.url);
  await Bun.write(
    configPath,
    JSON.stringify({
      ...JSON.parse(configText),
      dev: second,
    }),
  );
  // Reconfiguration must stop the first server before the replacement owns its port.
  await waitFor(
    "frontend server replacement",
    async () => (await starts()) === 4,
  );
  await expect(fetch(first.url)).rejects.toThrow();
  expect((await fetch(second.url)).ok).toBe(true);
  await Bun.write(close, "close");
  await running;
  await expect(fetch(second.url)).rejects.toThrow();
  console.log(
    "PASS frontend HMR ownership, backend restart, server reconfiguration and window-close teardown",
  );
} catch (error) {
  const message = `Development fixture failure before cleanup:\n${inspect(error)}\n`;
  // Windows self-signalling can terminate before an unhandled rejection is printed.
  // Save and emit the original failure before cleanup so the parent retains its phase and cause.
  await Bun.write(diagnostics, message);
  console.error(message);
  throw error;
} finally {
  // Notify the installed dev handler directly: Windows self-signalling can terminate
  // the fixture before its owners clean up and edited inputs are restored.
  if (running && !finished) {
    process.emit("SIGINT");
  }
  // Release the controlled build only after cancellation, then await all owned cleanup.
  repairStartup.resolve();
  if (running) {
    await running.catch(() => {});
  }
  // This generated project is shared by later tests, so restore every edited input.
  await Bun.write(configPath, configText);
  await Bun.write(ui, uiText);
  await Bun.write(backend, backendText);
  await rm(shared, {
    force: true,
  });
  console.error = originalError;
}
