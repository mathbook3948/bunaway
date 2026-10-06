// Exercise CLI orchestration with real frontend processes and a small host process.
// Native WebView behavior is covered separately by the platform integration runners.
import { expect, mock } from "bun:test";
import { resolve } from "node:path";
import * as build from "../../packages/cli/src/build.ts";
import * as launch from "../../packages/cli/src/launch.ts";

const root = process.argv[2];
if (!root) throw new Error("Expected a generated project.");
const marker = resolve(root, ".bunaway/host-starts.txt");
const close = resolve(root, ".bunaway/close-host.txt");
const host = resolve(root, ".bunaway/dev-host.ts");
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
    arguments: [host],
  }),
}));
mock.module(import.meta.resolve("../../packages/cli/src/launch.ts"), () => ({
  ...launch,
  verifyWindowsLaunch: async () => {},
  windowsLaunchEnvironment: () => process.env,
  closeWindowsApp: async (pid: number) => {
    process.kill(pid, "SIGTERM");
    return 1;
  },
}));

const { devProject } = await import("../../packages/cli/src/dev.ts");
const configPath = resolve(root, "src-bunaway/bunaway.json");
const configText = await Bun.file(configPath).text();
const ui = resolve(root, "src/main.ts");
const backend = resolve(root, "src-bunaway/src/index.ts");
const uiText = await Bun.file(ui).text();
const backendText = await Bun.file(backend).text();
function settings() {
  const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
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
async function starts() {
  try {
    return (await Bun.file(marker).text()).trim().split("\n").length;
  } catch {
    return 0;
  }
}
async function waitFor(check: () => Promise<boolean>) {
  const deadline = Date.now() + 10000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for development orchestration.");
    await Bun.sleep(40);
  }
}
const first = settings();
const second = settings();
let running: Promise<void> | undefined;
let finished = false;
try {
  await Bun.write(configPath, JSON.stringify({ ...JSON.parse(configText), dev: first }));
  running = devProject(root);
  void running.then(
    () => {
      finished = true;
    },
    () => {
      finished = true;
    },
  );
  await waitFor(async () => (await starts()) === 1);
  await Bun.write(ui, `${uiText}\n// frontend update\n`);
  await Bun.sleep(350);
  expect(await starts()).toBe(1);
  await Bun.write(backend, `${backendText}\n// backend update\n`);
  await waitFor(async () => (await starts()) === 2);
  expect((await fetch(first.url)).ok).toBe(true);
  await Bun.write(configPath, JSON.stringify({ ...JSON.parse(configText), dev: second }));
  await waitFor(async () => (await starts()) === 3);
  await expect(fetch(first.url)).rejects.toThrow();
  expect((await fetch(second.url)).ok).toBe(true);
  await Bun.write(close, "close");
  await running;
  await expect(fetch(second.url)).rejects.toThrow();
  console.log(
    "PASS frontend HMR ownership, backend restart, server reconfiguration and window-close teardown",
  );
} finally {
  if (running) {
    if (!finished) process.kill(process.pid, "SIGINT");
    await running.catch(() => {});
  }
  await Bun.write(configPath, configText);
  await Bun.write(ui, uiText);
  await Bun.write(backend, backendText);
}
