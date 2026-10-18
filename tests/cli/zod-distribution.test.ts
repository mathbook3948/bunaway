import { expect, setDefaultTimeout, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { installedPackageRoot } from "#cli/files";
import { assertZodWorker } from "../fixtures/assert-zod-worker.ts";
import { createProject } from "./project.ts";
import { deadline } from "../fixtures/deadlines.ts";

setDefaultTimeout(deadline("packagedAudit"));

async function run(project: string, args: string[]): Promise<void> {
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
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) {
    throw new Error(`Installed CLI failed (${code}): ${stdout}\n${stderr}`);
  }
}

test("installed CLI delivers the Zod patch to production and development app Workers", async () => {
  const home = await realpath(
    await mkdtemp(resolve(tmpdir(), "bunaway-zod-consumer-")),
  );
  try {
    const project = await createProject(resolve(home, "app"));
    const manifestPath = resolve(project, "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    await writeFile(
      manifestPath,
      JSON.stringify({
        ...manifest,
        devDependencies: {
          ...manifest.devDependencies,
          zod: "4.6.5",
        },
      }),
    );
    await run(project, [
      "install",
    ]);
    const cli = await installedPackageRoot(project, "@bunaway/cli");
    const zod = await installedPackageRoot(project, "zod");
    const original = await readFile(resolve(zod, "v4/core/schemas.js"), "utf8");
    // Consumers install ordinary upstream dependencies; the CLI must supply the fix itself.
    expect(original).not.toContain("util.observe(");
    const fixture = (
      await readFile(
        new URL("../fixtures/zod-async-worker.ts", import.meta.url),
        "utf8",
      )
    ).replace(
      '"../../native/host-api/bun/host-response.ts"',
      JSON.stringify(resolve(cli, "native/host-api/bun/host-response.ts")),
    );
    await writeFile(resolve(project, "src-bunaway/zod-worker.ts"), fixture);
    await writeFile(
      resolve(project, "src-bunaway/app.ts"),
      'import "./zod-worker.ts";\nexport default { commands: {}, events: {}, plugins: [] };\n',
    );
    for (const development of [
      false,
      true,
    ]) {
      const assets = resolve(home, development ? "development" : "production");
      await mkdir(assets);
      const build = resolve(project, "build-zod.ts");
      await writeFile(
        build,
        `import { validateProject } from ${JSON.stringify(pathToFileURL(resolve(cli, "packages/cli/src/config.ts")).href)};
import { bundleWindowsAssets } from ${JSON.stringify(pathToFileURL(resolve(cli, "packages/cli/src/assets.ts")).href)};
await bundleWindowsAssets(await validateProject(${JSON.stringify(project)}), ${JSON.stringify(assets)}, false, ${development});`,
      );
      await run(project, [
        build,
      ]);
      await assertZodWorker(resolve(assets, "app.js"));
    }
    // Replacing a dependency silently must never bypass the reviewed patch.
    const replacement = resolve(zod, "v4/core/unreviewed.js");
    await writeFile(replacement, `${original}\n// unreviewed change\n`);
    // Replace the project file instead of modifying Bun's shared cache hardlink.
    await rename(replacement, resolve(zod, "v4/core/schemas.js"));
    await expect(
      run(project, [
        resolve(project, "build-zod.ts"),
      ]),
    ).rejects.toThrow("Unsupported Zod runtime");
  } finally {
    await rm(home, {
      recursive: true,
      force: true,
    });
  }
});
