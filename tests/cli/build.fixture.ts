// Run the real CLI and frontend processes with fixture native inputs. OS host
// behavior and installer tooling are covered by platform integration runners.
import { mock, spyOn } from "bun:test";
import { copyFile, mkdir, rm as removeCompileAssets } from "node:fs/promises";
import { resolve } from "node:path";
import * as build from "../../packages/cli/src/build.ts";
import * as files from "../../packages/cli/src/files.ts";
import * as launch from "../../packages/cli/src/launch.ts";
import { adapterFor } from "../../packages/packaging/src/index.ts";

const compileSignal = process.env.BUNAWAY_TEST_COMPILE_SIGNAL === "1";
if (!compileSignal) {
  mock.module(import.meta.resolve("../../packages/cli/src/launch.ts"), () => ({
    ...launch,
    compileWindowsApp: async (
      root: string,
      _bun: string,
      executable: string,
    ) => {
      await Bun.write(resolve(root, executable), "fixture compiled app");
      await removeCompileAssets(resolve(root, "assets"), {
        recursive: true,
        force: true,
      });
    },
  }));
}
const project = process.argv[2];
if (!project) {
  throw new Error("Expected a generated project path.");
}
const nativeDir = resolve(project, ".bunaway/test-native");
const loader = resolve(nativeDir, "WebView2Loader.dll");
const native: build.NativeInputs = {
  target: "windows-x64",
  host: resolve(nativeDir, "bun.exe"),
  bun: resolve(nativeDir, "bun.exe"),
  loader,
  licenses: {
    "LICENSE.bun": resolve(nativeDir, "LICENSE.bun"),
    "License-WebView2.txt": resolve(nativeDir, "License-WebView2.txt"),
  },
};
await mkdir(nativeDir, {
  recursive: true,
});
if (compileSignal) {
  const port = Number(process.env.BUNAWAY_TEST_COMPILE_SIGNAL_PORT);
  const ready = process.env.BUNAWAY_TEST_COMPILE_SIGNAL_READY;
  if (!Number.isInteger(port) || port < 1 || !ready) {
    throw new Error("Expected compile signal fixture port and ready marker.");
  }
  const source = resolve(nativeDir, "compile-stall.ts");
  const descendant = `Bun.serve({hostname:'127.0.0.1',port:${port},fetch:()=>new Response('compiler descendant')}); await Bun.write(${JSON.stringify(ready)}, 'ready'); await Bun.sleep(600000);`;
  await Bun.write(
    source,
    `Bun.spawn([${JSON.stringify(process.execPath)}, '-e', ${JSON.stringify(descendant)}], {stdin:'ignore', stdout:'inherit', stderr:'inherit', windowsHide:true}); await Bun.sleep(600000);`,
  );
  const compiler = Bun.spawn(
    [
      process.execPath,
      "build",
      "--compile",
      "--target=bun-windows-x64-baseline",
      "--windows-hide-console",
      `--outfile=${native.bun}`,
      source,
    ],
    {
      cwd: nativeDir,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const compilerOutput = new Response(compiler.stdout).text();
  const compilerErrors = new Response(compiler.stderr).text();
  if (await compiler.exited) {
    throw new Error(
      `Cannot build compiler fixture:\n${await compilerOutput}\n${await compilerErrors}`,
    );
  }
  await compilerOutput;
  await compilerErrors;
} else {
  await Bun.write(native.bun, "fixture native input");
}
await Bun.write(loader, "fixture loader input");
for (const [name, path] of Object.entries(native.licenses)) {
  await copyFile(resolve(files.frameworkRoot, "licenses", name), path);
}
const readJson = files.json;
mock.module(import.meta.resolve("../../packages/cli/src/files.ts"), () => ({
  ...files,
  json: async (path: string) => {
    const value = await readJson(path);
    const normalized = path.replaceAll("\\", "/");
    if (normalized.endsWith("runtime/build-manifests/windows-x64.json")) {
      const pin = value as {
        bun: Record<string, unknown>;
      };
      return {
        ...(value as object),
        bun: {
          ...pin.bun,
          version: Bun.version,
          executableSha256: await files.hash(native.bun),
          licenseSha256: await files.hash(native.licenses["LICENSE.bun"] ?? ""),
        },
      };
    }
    if (normalized.endsWith("native/windows/bun/deps.json")) {
      return {
        webview2Sdk: {
          files: {
            "LICENSE.txt": await files.hash(
              native.licenses["License-WebView2.txt"] ?? "",
            ),
            "build/native/x64/WebView2Loader.dll": await files.hash(loader),
          },
        },
      };
    }
    return value;
  },
}));
const buildProject = build.buildProject;
mock.module(import.meta.resolve("../../packages/cli/src/build.ts"), () => ({
  ...build,
  currentTarget: () => "windows-x64",
  buildProject: (directory: string) =>
    buildProject(directory, {
      native,
    }),
}));
const adapter = adapterFor("win-direct");
if (!adapter) {
  throw new Error("Missing Windows packaging adapter.");
}
spyOn(adapter, "stages").mockImplementation(() => [
  {
    id: "assemble",
    title: "Assemble fixture installer",
    async run(ctx) {
      await Bun.write(resolve(ctx.staging, "setup.exe"), "fixture installer");
      ctx.addArtifact("setup.exe", "installer");
    },
  },
]);
if (process.argv[3] === "--development-artifact") {
  console.log(
    JSON.stringify(
      await buildProject(project, {
        native,
        development: true,
      }),
    ),
  );
} else {
  const { main } = await import("../../packages/cli/src/main.ts");
  process.exitCode = await main([
    ...(process.argv.slice(3).length
      ? process.argv.slice(3)
      : [
          "build",
        ]),
    project,
  ]);
}
