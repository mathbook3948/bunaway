import assert from "node:assert/strict";
import { cp, mkdir, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { closeWindowsApp } from "../../packages/cli/src/windows-dev-launch.ts";
import { createProject } from "../cli/project.ts";

assert.equal(process.platform, "win32");
const root = resolve(import.meta.dir, "../..");
const project = resolve(
  root,
  `build/windows-app-reload-${crypto.randomUUID()}`,
);
await createProject(project);
async function run(args: string[]) {
  const child = Bun.spawn(
    [
      process.execPath,
      ...args,
    ],
    {
      cwd: project,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  assert.equal(await child.exited, 0, `${await stdout}\n${await stderr}`);
}
await run([
  "install",
]);
const framework = resolve(project, "node_modules/@bunaway/cli");
const runtimeCache = resolve(framework, "runtime/bun-bundle/vendor");
await mkdir(runtimeCache, {
  recursive: true,
});
for (const name of [
  "bun-windows-x64-baseline.zip",
  "bun-windows-x64-baseline",
  "LICENSE.bun",
]) {
  await cp(
    resolve(root, "runtime/bun-bundle/vendor", name),
    resolve(runtimeCache, name),
    {
      recursive: true,
    },
  );
}
const nativeCache = resolve(framework, "native/windows/bun/vendor");
await mkdir(nativeCache, {
  recursive: true,
});
await cp(
  resolve(root, "native/windows/bun/vendor/webview2-1.0.4129.50.nupkg"),
  resolve(nativeCache, "webview2-1.0.4129.50.nupkg"),
);

const source = resolve(project, "src-bunaway/app.ts");
const service = resolve(project, "shared/counter.ts");
const reports = resolve(project, ".bunaway/reports");
await mkdir(resolve(project, "shared"));
await writeFile(
  service,
  "export const version: number = 1; export const step = 1; export let calls = 0; export function called() { return ++calls; }\n",
);
await writeFile(
  source,
  `
import { command, defineApp } from "@bunaway/backend";
import { BunawayError, s } from "@bunaway/plugin";
import { storage, storagePlugin } from "@bunaway/plugin-storage";
import { version, step, called } from "../shared/counter.ts";
export const app = defineApp({ modules: [], plugins: [storagePlugin], state: { count: 0 },
  events: { "counter.changed": s.integer(), ...(version === 3 ? { "counter.extra": s.integer() } : {}) },
  commands: {
    "counter.read": command({ input: s.null(), output: s.json(), handle(_input, context) {
      return { version, pid: process.pid, count: context.state.get("count") ?? 0 };
    } }),
    "counter.next": command({ input: s.null(), output: s.json(), async handle(_input, context) {
      const count = Number(context.state.get("count")) + step;
      context.state.set("count", count);
      await context.events.emit("counter.changed", count, { kind: "broadcast" });
      return { version, pid: process.pid, count, calls: called() };
    } }),
    "probe.failure": command({ input: s.null(), output: s.null(), handle() {
      throw new BunawayError({ code: "INVALID_ARGUMENT", message: "Expected reload probe error" });
    } }),
    "probe.storage": command({ input: s.null(), output: s.string(), async handle() {
      await storage.writeText({ scope: "appData", path: "messages/reload.txt", text: "reload storage" });
      return storage.readText({ scope: "appData", path: "messages/reload.txt" });
    } }),
    "probe.report": command({ input: s.json(), output: s.null(), async handle(payload) {
      await Bun.write(${JSON.stringify(reports)} + "/" + version + ".json", JSON.stringify(payload));
      return null;
    } }),
  },
});
export default app;
`,
);
const settingsPath = resolve(project, "src-bunaway/bunaway.json");
const settings = await Bun.file(settingsPath).json();
settings.app.appId = `reload.${crypto.randomUUID()}`;
await Bun.write(settingsPath, JSON.stringify(settings));
const policyPath = resolve(project, "src-bunaway/policy.json");
const policy = await Bun.file(policyPath).json();
policy.views[0].commands = [
  "counter.read",
  "counter.next",
  "probe.failure",
  "probe.storage",
  "probe.report",
];
policy.views[0].events = [
  "counter.changed",
];
await Bun.write(policyPath, JSON.stringify(policy));
await writeFile(
  resolve(project, "src/main.ts"),
  `
import { createClient } from "@bunaway/client";
import type { JsonValue } from "@bunaway/plugin";
const client = createClient();
await client.ready;
const instance = crypto.randomUUID();
const draft = document.createElement("input"); draft.value = "unsaved draft"; document.body.append(draft);
const events: Array<{ sequence: number; payload: JsonValue; subscriptionId: string }> = [];
await client.listen("counter.changed", event => events.push(event), { onError(error) { throw new Error(error.message); } });
let previousVersion = 0;
let sample: JsonValue = null;
for (;;) {
  const current = await client.invoke("counter.read", null);
  if (!current || typeof current !== "object" || Array.isArray(current) || typeof current.version !== "number") throw new Error("Invalid probe state");
  if (current.version !== previousVersion) {
    sample = await client.invoke("counter.next", null);
    previousVersion = current.version;
  }
  let errorCode = "";
  try { await client.invoke("probe.failure", null); } catch (error) {
    if (error && typeof error === "object" && "code" in error) errorCode = String(error.code);
  }
  const stored = await client.invoke("probe.storage", null);
  await client.invoke("probe.report", { instance, sample, events, errorCode, stored,
    draftRetained: document.contains(draft) && draft.value === "unsaved draft" });
  if (current.version === 3) { await client.close(); window.close(); break; }
  await new Promise(resolve => setTimeout(resolve, 200));
}
`,
);
await writeFile(
  resolve(project, "src/client.ts"),
  `
import type { CommandsOf, EventsOf } from "@bunaway/backend";
import { createClient } from "@bunaway/client";
import type { app } from "../src-bunaway/app.ts";
export const client = createClient<CommandsOf<typeof app>, EventsOf<typeof app>>();
`,
);
// This uses declared SDK dependencies in the generated app before its actual dev run.
await run([
  "run",
  "typecheck",
]);
const child = Bun.spawn(
  [
    process.execPath,
    resolve(framework, "packages/cli/src/distribution-main.ts"),
    "dev",
    project,
  ],
  {
    cwd: project,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  },
);
let output = "";
let errors = "";
const stdout = child.stdout.pipeTo(
  new WritableStream({
    write(chunk) {
      output += new TextDecoder().decode(chunk);
    },
  }),
);
const stderr = child.stderr.pipeTo(
  new WritableStream({
    write(chunk) {
      errors += new TextDecoder().decode(chunk);
    },
  }),
);
const timeout = setTimeout(() => child.kill(), 90000);
/** Polls while failing early if the development process exits or times out. */
async function waitFor(check: () => Promise<boolean> | boolean) {
  const deadline = Date.now() + 30000;
  while (!(await check())) {
    assert.equal(child.exitCode, null, `${output}\n${errors}`);
    assert(Date.now() < deadline, `Timed out: ${output}\n${errors}`);
    await Bun.sleep(40);
  }
}
/** Waits until a report's sample matches the expected command version. */
async function reportReady(version: number): Promise<boolean> {
  const file = Bun.file(resolve(reports, `${version}.json`));
  if (!(await file.exists())) {
    return false;
  }
  try {
    // A code swap can occur between reading the version and writing the report.
    return (await file.json()).sample.version === version;
  } catch (error) {
    if (error instanceof SyntaxError) {
      return false;
    }
    throw error;
  }
}
try {
  const firstFile = Bun.file(resolve(reports, "1.json"));
  await waitFor(() => reportReady(1));
  const first = await firstFile.json();
  assert.equal(first.sample.count, 1);
  assert.equal(first.errorCode, "INVALID_ARGUMENT");
  assert.equal(first.stored, "reload storage");
  const initialWrites = output.match(/window-created/g)?.length ?? 0;
  // A syntax error must leave the running app on its last valid implementation.
  await writeFile(service, "export const broken = ;\n");
  await waitFor(() =>
    errors.includes("Dev build failed; running app retained"),
  );
  const failedBuildAt = (await stat(resolve(reports, "1.json"))).mtimeMs;
  await waitFor(
    async () =>
      (await stat(resolve(reports, "1.json"))).mtimeMs > failedBuildAt,
  );
  const whileBroken = await firstFile.json();
  assert.equal(whileBroken.instance, first.instance);
  assert.equal(whileBroken.sample.pid, first.sample.pid);
  assert.equal(whileBroken.sample.count, 1);
  await writeFile(
    service,
    "export const version: number = 2; export const step = 10; export let calls = 0; export function called() { return ++calls; }\n",
  );
  const secondFile = Bun.file(resolve(reports, "2.json"));
  await waitFor(() => reportReady(2));
  const second = await secondFile.json();
  assert.equal(second.instance, first.instance);
  assert.equal(second.sample.pid, first.sample.pid);
  assert.equal(second.sample.count, 11);
  assert.equal(second.sample.calls, 1);
  assert(second.draftRetained);
  assert.equal(second.errorCode, "INVALID_ARGUMENT");
  assert.equal(second.stored, "reload storage");
  assert.deepEqual(
    second.events.map((event: { sequence: number }) => event.sequence),
    [
      1,
      2,
    ],
  );
  assert.equal(
    new Set(
      second.events.map(
        (event: { subscriptionId: string }) => event.subscriptionId,
      ),
    ).size,
    1,
  );
  assert.equal(output.match(/window-created/g)?.length, initialWrites);
  assert(output.includes("App code reloaded"));
  // An event-contract change requires a new host and UI session.
  await writeFile(
    service,
    "export const version: number = 3; export const step = 100; export let calls = 0; export function called() { return ++calls; }\n",
  );
  const thirdFile = Bun.file(resolve(reports, "3.json"));
  await waitFor(() => reportReady(3));
  const third = await thirdFile.json();
  assert.notEqual(third.instance, first.instance);
  assert.notEqual(third.sample.pid, first.sample.pid);
  assert.equal(third.sample.count, 100);
  assert.equal(await child.exited, 0, errors);
  await Promise.all([
    stdout,
    stderr,
  ]);
  assert.equal(output.match(/window-created/g)?.length, initialWrites + 1);
  console.log(
    JSON.stringify({
      event: "app-reload-passed",
      first,
      second,
      third,
    }),
  );
} finally {
  clearTimeout(timeout);
  if (child.exitCode === null) {
    // Ask every reported app process to close before terminating the dev supervisor.
    for (const version of [
      1,
      2,
      3,
    ]) {
      const reportFile = Bun.file(resolve(reports, `${version}.json`));
      if (await reportFile.exists()) {
        const report = await reportFile.json();
        await closeWindowsApp(report.sample.pid);
      }
    }
  }
  if (child.exitCode === null) {
    child.kill();
    await child.exited;
  }
  await Promise.all([
    stdout,
    stderr,
  ]);
  await writeFile(resolve(project, "dev-stdout.log"), output);
  await writeFile(resolve(project, "dev-stderr.log"), errors);
}
