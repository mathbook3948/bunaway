import assert from "node:assert/strict";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { packageFilename } from "#cli/distribution";
import { writeJson } from "#cli/files";
import { createProject, packageDirectory } from "../cli/project.ts";
import { waitFor } from "../fixtures/deadlines.ts";
import { seedWindowsBuildCaches } from "./windows-project-caches.ts";

/**
 * Packages an app whose `build.resources` carries a sidecar executable and a license notice, runs
 * the packaged app, and checks that its backend starts the sidecar from `ctx.app.paths.resources`
 * through `processes.spawn`. The sidecar is a copy of the Bun runtime that prints its own path, so
 * the run proves the packaged file was the one executed. Installing the package and signing are
 * not covered.
 */
assert.equal(process.platform, "win32");
const root = resolve(import.meta.dir, "../..");
const home = resolve(root, `build/windows-sidecar-${crypto.randomUUID()}`);
const reportPath = resolve(home, "sidecar-report.json");

/** Runs a project-local Bun command and includes both output streams on failure. */
async function command(project: string, args: string[]): Promise<void> {
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
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  assert.equal(code, 0, `${out}\n${err}`);
}

// The directory stays after the run like the other build fixtures: the stopped app can still hold
// handles on its files for a moment, and `build/` is scratch space.
await mkdir(home, {
  recursive: true,
});
const project = await createProject(resolve(home, "app"));
const packagePath = resolve(project, "package.json");
const manifest = (await Bun.file(packagePath).json()) as {
  dependencies: Record<string, string>;
};
manifest.dependencies["@bunaway/plugin-process"] = `file:${resolve(
  await packageDirectory(),
  packageFilename("@bunaway/plugin-process", "0.0.0"),
)}`;
await writeJson(packagePath, manifest);
await command(project, [
  "install",
]);
await seedWindowsBuildCaches(project, root);

await mkdir(resolve(project, "sidecar"));
await copyFile(process.execPath, resolve(project, "sidecar/probe.exe"));
await writeFile(
  resolve(project, "sidecar/LICENSE.txt"),
  "Sidecar license notice\n",
);

await writeFile(
  resolve(project, "src-bunaway/app.ts"),
  `
import { command, defineApp } from "@bunaway/backend";
import processes from "@bunaway/plugin-process";
import { join } from "node:path";
import { rename } from "node:fs/promises";
export const app = defineApp({ modules: [], plugins: [processes], commands: {
  "sidecar.run": command({ input: { const: null } as const, output: { const: null } as const, async handle(_input, context) {
    if (!context.app.paths) throw new Error("The host reports no app paths.");
    const executablePath = join(context.app.paths.resources, "sidecar", "probe.exe");
    const { handle } = await processes.spawn({ executablePath, args: ["--no-env-file", "-e", "console.log(process.execPath)"] });
    let stdout = "";
    let exited: { exitCode: number } | null = null;
    while (!exited) {
      const read = await processes.read({ handle, waitMs: 1000 });
      stdout += Buffer.from(read.stdoutBase64, "base64").toString();
      exited = read.exited;
    }
    // Publish a complete report: the driver reads while the file is written.
    await Bun.write(${JSON.stringify(reportPath)} + ".pending", JSON.stringify({ executablePath, stdout: stdout.trim(), exitCode: exited.exitCode }));
    await rename(${JSON.stringify(reportPath)} + ".pending", ${JSON.stringify(reportPath)});
    return null;
  } }),
} });
export default app;
`,
);
const settingsPath = resolve(project, "src-bunaway/bunaway.json");
const settings = JSON.parse(await readFile(settingsPath, "utf8"));
settings.app.appId = `sidecar.${crypto.randomUUID()}`;
settings.build.resources = [
  "sidecar",
];
await writeJson(settingsPath, settings);
const policyPath = resolve(project, "src-bunaway/policy.json");
const policy = JSON.parse(await readFile(policyPath, "utf8"));
policy.views[0].commands = [
  "sidecar.run",
];
policy.views[0].events = [];
policy.views[0].host.permissions = [
  "process.spawn",
  "process.read",
];
await writeJson(policyPath, policy);
await writeFile(
  resolve(project, "src/main.ts"),
  `
import { client } from "./client.ts";
await client.invoke("sidecar.run", null);
window.close();
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
await command(project, [
  "run",
  "build",
]);

const packageRoot = resolve(project, "dist/windows-x64");
const packagedSidecar = resolve(packageRoot, "sidecar/probe.exe");
assert(
  (await stat(packagedSidecar)).isFile(),
  "The sidecar executable was not packaged.",
);
assert.equal(
  await readFile(resolve(packageRoot, "sidecar/LICENSE.txt"), "utf8"),
  "Sidecar license notice\n",
);

const launched = Bun.spawn(
  [
    resolve(packageRoot, `${settings.app.appId}.exe`),
  ],
  {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  },
);
try {
  await waitFor(() => Bun.file(reportPath).exists(), {
    deadline: "nativeFixture",
    what: "the packaged app to report the sidecar run",
    intervalMs: 100,
  });
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  assert.equal(report.exitCode, 0);
  assert.equal(
    report.executablePath.toLowerCase(),
    packagedSidecar.toLowerCase(),
  );
  assert.equal(report.stdout.toLowerCase(), packagedSidecar.toLowerCase());
} finally {
  // The launcher owns Bun and WebView2 children; stop the whole tree.
  Bun.spawnSync([
    "taskkill",
    "/PID",
    String(launched.pid),
    "/T",
    "/F",
  ]);
}
console.log("PASS: Windows bundled sidecar runs from the packaged resources");
