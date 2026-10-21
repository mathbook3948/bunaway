import assert from "node:assert/strict";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  baselineProbeSource,
  measureBaseline,
} from "../../scripts/measure-baseline.ts";
import { createProject } from "../cli/project.ts";
import { seedWindowsBuildCaches } from "./windows-project-caches.ts";

/**
 * Builds the default template as a packaged Windows app with the baseline probe and records its
 * measurements in `build/windows-baseline-results.json`, which the native job uploads. The
 * numbers are recorded, not asserted: only a failure to build, launch or measure fails this run.
 * Definitions of the metrics are in `scripts/measure-baseline.ts`.
 */
assert.equal(process.platform, "win32");
const root = resolve(import.meta.dir, "../..");
const home = resolve(root, `build/windows-baseline-${crypto.randomUUID()}`);
const report = resolve(root, "build/windows-baseline-results.json");

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

try {
  await mkdir(home, {
    recursive: true,
  });
  const project = await createProject(resolve(home, "app"));
  await command(project, [
    "install",
  ]);
  await seedWindowsBuildCaches(project, root);
  await appendFile(resolve(project, "src/main.ts"), baselineProbeSource());
  await command(project, [
    "run",
    "build",
  ]);
  const settings = JSON.parse(
    await readFile(resolve(project, "src-bunaway/bunaway.json"), "utf8"),
  );
  const measured = await measureBaseline({
    packageRoot: resolve(project, "dist/windows-x64"),
    appId: settings.app.appId,
    runs: 5,
    idleMs: 5_000,
  });
  await writeFile(report, `${JSON.stringify(measured, null, 2)}\n`);
  console.log(JSON.stringify(measured.summary, null, 2));
  console.log("PASS: Windows baseline measurements recorded");
} finally {
  await rm(home, {
    recursive: true,
    force: true,
  });
}
