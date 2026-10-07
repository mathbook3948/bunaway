import { chmod, cp, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import {
  checkArtifact,
  copyFramework,
  packageFilename,
  type Release,
  release,
  snapshotHashes,
} from "../src/distribution.ts";
import { files, frameworkRoot, run, writeJson } from "../src/files.ts";

async function writeDeclarations(stage: string, info: Release): Promise<void> {
  const declarations = resolve(stage, "packages/cli/dist/types");
  const aliases = new Map<string, string>();
  for (const [directory, name] of Object.entries(info.packages)) {
    aliases.set(name, resolve(declarations, `${directory}/src/index.js`));
    await run(
      [
        process.execPath,
        "run",
        "tsc",
        "--project",
        resolve(frameworkRoot, `packages/${directory}/tsconfig.json`),
        "--noEmit",
        "false",
        "--declaration",
        "--emitDeclarationOnly",
        "--rootDir",
        resolve(frameworkRoot, "packages"),
        "--declarationDir",
        declarations,
      ],
      frameworkRoot,
    );
  }
  for (const path of await files(declarations)) {
    const source = await readFile(path, "utf8");
    const rewritten = source.replace(
      /(\bfrom\s+|\bimport\s*(?:\(\s*)?)(["'])([^"']+)\2/g,
      (_match, prefix: string, quote: string, specifier: string) => {
        const alias =
          specifier === "#transport"
            ? resolve(declarations, "plugin-sdk/src/bun.js")
            : aliases.get(specifier);
        if (alias) {
          specifier = relative(dirname(path), alias).replaceAll("\\", "/");
          if (!specifier.startsWith(".")) specifier = `./${specifier}`;
        } else if (specifier.startsWith(".")) {
          specifier = specifier.replace(/\.ts$/, ".js");
        } else if (specifier.startsWith("@bunaway/")) {
          throw new Error(`Unresolved declaration dependency: ${specifier}`);
        }
        return `${prefix}${quote}${specifier}${quote}`;
      },
    );
    await writeFile(path, rewritten);
  }
}

export async function packFramework(
  destination = resolve(frameworkRoot, "build/framework"),
  options: { localDependencies?: boolean } = {},
): Promise<string> {
  destination = resolve(destination);
  await mkdir(destination, { recursive: true });
  destination = await realpath(destination);
  const info = await release();
  const dependency = (name: string) =>
    options.localDependencies
      ? `file:${resolve(destination, packageFilename(name, info.version)).replaceAll("\\", "/")}`
      : info.version;
  if (Bun.version !== info.bun) throw new Error(`Pack requires Bun ${info.bun}.`);
  const stage = resolve(destination, `staging-${crypto.randomUUID()}`);
  await mkdir(stage, { recursive: true });
  try {
    await copyFramework(stage);
    // SDK packages are ordinary dependencies; native inputs stay in the CLI artifact.
    for (const [directory, name] of [
      ...Object.entries(info.packages),
      ...Object.entries(info.plugins),
    ]) {
      if (name === "@bunaway/cli") continue;
      const sdk = resolve(destination, `sdk-${crypto.randomUUID()}`);
      await mkdir(sdk);
      try {
        const source = resolve(
          frameworkRoot,
          `${name.startsWith("@bunaway/plugin-") ? "plugins" : "packages"}/${directory}`,
        );
        await cp(resolve(source, "src"), resolve(sdk, "src"), {
          recursive: true,
        });
        const manifest = JSON.parse(await readFile(resolve(source, "package.json"), "utf8"));
        delete manifest.scripts;
        delete manifest.devDependencies;
        if (manifest.bunaway?.plugin)
          await cp(resolve(source, "plugin.json"), resolve(sdk, "plugin.json"));
        for (const field of ["dependencies", "peerDependencies"]) {
          for (const dep of Object.keys(manifest[field] ?? {})) {
            if (dep.startsWith("@bunaway/")) manifest[field][dep] = dependency(dep);
          }
        }
        await writeJson(resolve(sdk, "package.json"), {
          ...manifest,
          files: [
            "src",
            ...(manifest.bunaway?.plugin ? ["plugin.json"] : []),
            "LICENSE.txt",
            "THIRD-PARTY-NOTICES.txt",
          ],
        });
        await cp(resolve(frameworkRoot, "FRAMEWORK-LICENSE.txt"), resolve(sdk, "LICENSE.txt"));
        await cp(
          resolve(frameworkRoot, "THIRD-PARTY-NOTICES.txt"),
          resolve(sdk, "THIRD-PARTY-NOTICES.txt"),
        );
        await run(
          [
            process.execPath,
            "pm",
            "pack",
            "--ignore-scripts",
            "--filename",
            resolve(destination, packageFilename(name, info.version)),
            "--quiet",
          ],
          sdk,
        );
      } finally {
        await rm(sdk, { recursive: true, force: true });
      }
    }
    // The internal source graph in the CLI must use the same installed release.
    for (const directory of Object.keys(info.packages)) {
      const path = resolve(stage, `packages/${directory}/package.json`);
      const manifest = JSON.parse(await readFile(path, "utf8"));
      for (const dep of Object.keys(manifest.dependencies ?? {})) {
        if (dep.startsWith("@bunaway/")) manifest.dependencies[dep] = dependency(dep);
      }
      await writeJson(path, manifest);
    }
    await writeFile(
      resolve(stage, "README.md"),
      "# bunaway developer framework\n\nBun 1.4.2 required. Local artifact only; no public registry release.\nSee [installation, versions and upgrades](docs/framework-distribution.md).\nFramework license is undecided; see FRAMEWORK-LICENSE.txt.\n",
    );
    await writeJson(resolve(stage, "package.json"), {
      name: "@bunaway/cli",
      version: info.version,
      private: true,
      type: "module",
      license: "UNLICENSED",
      engines: { bun: info.bun },
      dependencies: Object.fromEntries(
        Object.values(info.packages)
          .filter((name) => name !== "@bunaway/cli")
          .map((name) => [name, dependency(name)]),
      ),
      bin: { bunaway: "./packages/cli/dist/distribution-main.js" },
      types: "./packages/cli/dist/types/cli/src/index.d.ts",
      exports: {
        "./package.json": "./package.json",
        ".": {
          types: "./packages/cli/dist/types/cli/src/index.d.ts",
          default: "./packages/cli/dist/index.js",
        },
      },
      files: [
        "packages",
        "native",
        "runtime/build-manifests",
        "licenses",
        "docs",
        "framework.json",
        "artifact.files.json",
        "tsconfig.base.json",
        "FRAMEWORK-LICENSE.txt",
        "THIRD-PARTY-NOTICES.txt",
        "README.md",
      ],
    });
    for (const entry of ["distribution-main", "index"]) {
      const built = await Bun.build({
        entrypoints: [resolve(frameworkRoot, `packages/cli/src/${entry}.ts`)],
        target: "bun",
      });
      if (!built.success || built.outputs.length !== 1)
        throw new Error(`CLI bundle failed: ${built.logs.join("\n")}`);
      const output = resolve(stage, `packages/cli/dist/${entry}.js`);
      await mkdir(dirname(output), { recursive: true });
      const artifact = built.outputs[0];
      if (!artifact) throw new Error("Missing CLI bundle.");
      await Bun.write(output, artifact);
      await chmod(output, 0o755);
    }
    await writeDeclarations(stage, info);
    await writeJson(resolve(stage, "artifact.files.json"), await snapshotHashes(stage));
    await checkArtifact(stage);
    const temporary = resolve(destination, `pack-${crypto.randomUUID()}.tgz`);
    await run(
      [process.execPath, "pm", "pack", "--ignore-scripts", "--filename", temporary, "--quiet"],
      stage,
    );
    const artifact = resolve(destination, packageFilename("@bunaway/cli", info.version));
    await rm(artifact, { force: true });
    await rename(temporary, artifact);
    return artifact;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

if (import.meta.main)
  console.log(
    await packFramework(
      process.argv.slice(2).find((arg) => arg !== "--local"),
      { localDependencies: process.argv.includes("--local") },
    ),
  );
