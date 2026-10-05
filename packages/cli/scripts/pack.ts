import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import {
  checkArtifact,
  copyFramework,
  release,
  type Release,
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
        const alias = aliases.get(specifier);
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
): Promise<string> {
  const info = await release();
  if (Bun.version !== info.bun) throw new Error(`Pack requires Bun ${info.bun}.`);
  const stage = resolve(destination, `staging-${crypto.randomUUID()}`);
  await mkdir(stage, { recursive: true });
  try {
    await copyFramework(stage);
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
      bin: { bunaway: "./packages/cli/dist/distribution-main.js" },
      types: "./packages/cli/dist/types/cli/src/index.d.ts",
      exports: {
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
    const artifact = resolve(destination, `bunaway-cli-${info.version}.tgz`);
    await rm(artifact, { force: true });
    await rename(temporary, artifact);
    return artifact;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

if (import.meta.main) console.log(await packFramework(process.argv[2]));
