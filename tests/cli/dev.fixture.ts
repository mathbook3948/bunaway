// Exercise CLI orchestration with real frontend processes and a small host process.
// Native WebView behavior is covered separately by the platform integration runners.
import { expect, mock } from "bun:test";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import * as build from "../../packages/cli/src/build.ts";
import * as windowsDevLaunch from "../../packages/cli/src/windows-dev-launch.ts";

const root = process.argv[2];
if (!root) {
  throw new Error("Expected a generated project.");
}
const marker = resolve(root, ".bunaway/host-starts.txt");
const close = resolve(root, ".bunaway/close-host.txt");
const host = resolve(root, ".bunaway/dev-host.ts");
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
mock.module(import.meta.resolve("../../packages/cli/src/build.ts"), () => ({
  ...build,
  prepareNative: async () => ({
    target: "windows-x64",
    host: process.execPath,
    bun: process.execPath,
    licenses: {},
  }),
  buildProject: async () => ({
    output: root,
    package: root,
    executable: process.execPath,
    arguments: [
      host,
    ],
  }),
}));
mock.module(
  import.meta.resolve("../../packages/cli/src/windows-dev-launch.ts"),
  () => ({
    ...windowsDevLaunch,
    verifyWindowsLaunch: async () => {},
    windowsLaunchEnvironment: () => process.env,
    closeWindowsApp: async (pid: number) => {
      process.kill(pid, "SIGTERM");
      return 1;
    },
  }),
);

const { devProject } = await import("../../packages/cli/src/dev.ts");
const configPath = resolve(root, "src-bunaway/bunaway.json");
const configText = await Bun.file(configPath).text();
const ui = resolve(root, "src/main.ts");
const backend = resolve(root, "src-bunaway/app.ts");
const uiText = await Bun.file(ui).text();
const backendText = await Bun.file(backend).text();
const shared = resolve(root, "shared/development-value.ts");
const sharedImport = 'import "../shared/development-value.ts";\n';
const failureMode = process.argv[3];
const brokenStart = [
  "broken-start",
  "broken-shared",
  "missing-shared",
].includes(failureMode ?? "");
const originalError = console.error;
let buildFailed = false;
console.error = (...args: unknown[]) => {
  if (String(args[0]).includes("Dev build failed")) {
    buildFailed = true;
  }
  originalError(...args);
};
/** Reserves a loopback port and configures a real server fixture on it. */
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
async function waitFor(check: () => Promise<boolean>) {
  const deadline = Date.now() + 10000;
  while (!(await check())) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for development orchestration.");
    }
    await Bun.sleep(40);
  }
}
const first = settings();
const second = settings();
let running: Promise<void> | undefined;
let finished = false;
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
    () => {
      finished = true;
    },
  );
  if (brokenStart) {
    await waitFor(async () => buildFailed);
    expect(finished).toBe(false);
    expect(await starts()).toBe(0);
    await expect(fetch(first.url)).rejects.toThrow();
    if (failureMode === "broken-start") {
      await Bun.write(backend, sharedImport + backendText);
    } else {
      await Bun.write(shared, 'console.error("repaired shared dependency");\n');
    }
  }
  await waitFor(async () => (await starts()) === 1);
  // UI edits stay in Vite's HMR loop; backend edits replace the native host.
  await Bun.write(ui, `${uiText}\n// frontend update\n`);
  await Bun.sleep(350);
  expect(await starts()).toBe(1);
  await Bun.write(
    backend,
    `${sharedImport}${backendText}\n// backend update\n`,
  );
  await waitFor(async () => (await starts()) === 2);
  expect((await fetch(first.url)).ok).toBe(true);
  await Bun.write(shared, 'console.error("updated shared dependency");\n');
  await waitFor(async () => (await starts()) === 3);
  expect((await fetch(first.url)).ok).toBe(true);
  await Bun.write(
    configPath,
    JSON.stringify({
      ...JSON.parse(configText),
      dev: second,
    }),
  );
  // Reconfiguration must stop the first server before the replacement owns its port.
  await waitFor(async () => (await starts()) === 4);
  await expect(fetch(first.url)).rejects.toThrow();
  expect((await fetch(second.url)).ok).toBe(true);
  await Bun.write(close, "close");
  await running;
  await expect(fetch(second.url)).rejects.toThrow();
  console.log(
    "PASS frontend HMR ownership, backend restart, server reconfiguration and window-close teardown",
  );
} finally {
  // This generated project is shared by later tests, so restore every edited input.
  if (running) {
    if (!finished) {
      process.kill(process.pid, "SIGINT");
    }
    await running.catch(() => {});
  }
  await Bun.write(configPath, configText);
  await Bun.write(ui, uiText);
  await Bun.write(backend, backendText);
  await rm(shared, {
    force: true,
  });
  console.error = originalError;
}
