import { chmod, cp, lstat, mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import { acquireBuildOutputLock, ownedDirectory, PACKAGING_CHANNELS } from "@bunaway/packaging";
import { developmentPolicy } from "../../runtime-bun/src/development.ts";
import { type Project, readProjectMetadata, validateProject } from "./config.ts";
import {
  files,
  frameworkRoot,
  hash,
  json,
  run,
  runWorker,
  verifyHash,
  writeJson,
} from "./files.ts";
import { assertNotFrontendBuild, buildFrontend } from "./frontend-build.ts";
import { writeWindowsLauncher } from "./launch.ts";
import { runManagedCommand } from "./managed-command.ts";

export type Target = "windows-x64" | "macos-arm64";
export interface NativeInputs {
  target: Target;
  host: string;
  bun: string;
  licenses: Record<string, string>;
  loader?: string;
}
interface Pin {
  bun: { version: string; target: string; executableSha256: string; licenseSha256: string };
  json?: { licenseSha256: string };
}
export interface BuiltPackage {
  output: string;
  package: string;
  executable: string;
  arguments: string[];
}

export function currentTarget(): Target {
  if (process.platform === "win32" && process.arch === "x64") return "windows-x64";
  if (process.platform === "darwin" && process.arch === "arm64") return "macos-arm64";
  throw new Error("MVP builds require Windows x64 or macOS arm64 (native builds only).");
}

async function readPin(target: Target, root = frameworkRoot): Promise<Pin> {
  return (await json(
    resolve(
      root,
      "runtime/build-manifests",
      target === "windows-x64" ? "windows-x64.json" : "darwin-aarch64.json",
    ),
  )) as Pin;
}

export async function assertBuildBun(target: Target, root = frameworkRoot): Promise<void> {
  if (Bun.version !== (await readPin(target, root)).bun.version) {
    throw new Error("Development/build Bun must match the pinned version (1.4.2).");
  }
}

export async function prepareNative(
  target: Target = currentTarget(),
  root = frameworkRoot,
): Promise<NativeInputs> {
  return prepareNativeForBuild(target, root);
}

async function prepareNativeForBuild(
  target: Target,
  root: string,
  signal?: AbortSignal,
): Promise<NativeInputs> {
  if (target !== currentTarget()) throw new Error("Cross compilation is not supported in the MVP.");
  await assertBuildBun(target, root);
  const windows = target === "windows-x64";
  const args = windows
    ? ["pwsh", "-NoProfile", "-File", resolve(root, "native/windows/bun/prepare.ps1")]
    : ["zsh", resolve(root, "native/macos/host/run.sh"), "--host-only"];
  if (signal) await runManagedCommand(args, root, { BUN: process.execPath }, signal, root);
  else await run(args, root, { BUN: process.execPath });
  const pin = await readPin(target, root);
  const vendor = resolve(root, "runtime/bun-bundle/vendor");
  const licenses: Record<string, string> = {
    "FRAMEWORK-LICENSE.txt": resolve(root, "FRAMEWORK-LICENSE.txt"),
    "THIRD-PARTY-NOTICES.txt": resolve(root, "THIRD-PARTY-NOTICES.txt"),
    "LICENSE.bun": resolve(vendor, "LICENSE.bun"),
  };
  if (windows)
    licenses["License-WebView2.txt"] = resolve(root, "native/windows/bun/vendor/sdk/LICENSE.txt");
  else
    licenses["LICENSE.nlohmann-json"] = resolve(root, "native/macos/vendor/LICENSE.nlohmann-json");
  return {
    target,
    host: resolve(root, windows ? "native/windows/bun/boot.ts" : "build/macos-host/bunaway-host"),
    ...(windows
      ? {
          loader: resolve(
            root,
            "native/windows/bun/vendor/sdk/build/native/x64/WebView2Loader.dll",
          ),
        }
      : {}),
    bun: resolve(vendor, `bun-${pin.bun.target}/bun${windows ? ".exe" : ""}`),
    licenses,
  };
}

export async function bundleAssets(
  project: Project,
  assets: string,
  windows = false,
  developmentServer = false,
): Promise<void> {
  await runWorker(
    "assets.ts",
    windows ? "bundleWindowsAssets" : "bundleAssets",
    [project, assets, developmentServer],
    project.root,
    project.frameworkRoot,
  );
}

function xml(text: string): string {
  return text.replace(
    /[<>&"']/g,
    (character) =>
      ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[character] ??
      character,
  );
}

export async function buildProject(
  directory: string,
  options: { development?: boolean; native?: NativeInputs } = {},
): Promise<BuiltPackage> {
  if (options.development) {
    const project = await validateProject(directory, { development: true });
    return assembleProject(project, options);
  }
  const settings = await readProjectMetadata(directory);
  assertNotFrontendBuild(settings.root);
  const target = options.native?.target ?? currentTarget();
  await assertBuildBun(target, settings.frameworkRoot);
  // The lock covers frontend generation, asset validation and publication so
  // another build cannot change the web output while this build consumes it.
  const abort = new AbortController();
  const interrupted = () => abort.abort(new Error("App build cancelled (SIGINT)."));
  const terminated = () => abort.abort(new Error("App build cancelled (SIGTERM)."));
  process.on("SIGINT", interrupted);
  process.on("SIGTERM", terminated);
  let release: (() => Promise<void>) | undefined;
  try {
    release = await acquireBuildOutputLock(settings.root, target);
    await buildFrontend(settings, abort.signal);
    const project = await validateProject(settings.root);
    abort.signal.throwIfAborted();
    return await assembleProject(project, options, abort.signal);
  } finally {
    try {
      await release?.();
    } finally {
      process.off("SIGINT", interrupted);
      process.off("SIGTERM", terminated);
    }
  }
}

async function assembleProject(
  project: Project,
  options: { development?: boolean; native?: NativeInputs },
  signal?: AbortSignal,
): Promise<BuiltPackage> {
  signal?.throwIfAborted();
  const root = project.frameworkRoot;
  const server = options.development ? project.dev : undefined;
  const target = options.native?.target ?? currentTarget();
  await assertBuildBun(target, root);
  const native = options.native ?? (await prepareNativeForBuild(target, root, signal));
  signal?.throwIfAborted();
  const windows = target === "windows-x64";
  const pin = await readPin(target, root);
  await verifyHash(native.bun, pin.bun.executableSha256);
  await verifyHash(native.licenses["LICENSE.bun"] ?? "", pin.bun.licenseSha256);
  if (!windows)
    await verifyHash(native.licenses["LICENSE.nlohmann-json"] ?? "", pin.json?.licenseSha256 ?? "");
  if (windows) {
    const deps = (await json(resolve(root, "native/windows/bun/deps.json"))) as {
      webview2Sdk: { files: Record<string, string> };
    };
    await verifyHash(
      native.licenses["License-WebView2.txt"] ?? "",
      deps.webview2Sdk.files["LICENSE.txt"] ?? "",
    );
  }
  await stat(native.host);
  const parent = resolve(project.root, options.development ? ".bunaway" : "dist");
  await ownedDirectory(project.root, parent, true);
  const output = resolve(parent, `${target}${windows ? "" : `/${project.app.appId}.app`}`);
  await ownedDirectory(project.root, dirname(output), true);
  const staging = `${output}.building-${crypto.randomUUID()}`;
  const packageRoot = windows ? staging : resolve(staging, "Contents/Resources");
  const executable = windows
    ? resolve(staging, "runtime/bun.exe")
    : resolve(staging, "Contents/MacOS/bunaway-host");
  const preserved: { source: string; destination: string }[] = [];
  let published = false;
  try {
    const assets = resolve(packageRoot, "assets");
    await mkdir(resolve(assets, "web"), { recursive: true });
    await mkdir(resolve(packageRoot, "runtime"), { recursive: true });
    await mkdir(resolve(packageRoot, "licenses"), { recursive: true });
    await mkdir(dirname(executable), { recursive: true });
    if (!windows) await cp(native.host, executable);
    await cp(native.bun, resolve(packageRoot, `runtime/bun${windows ? ".exe" : ""}`));
    await chmod(executable, 0o755);
    await chmod(resolve(packageRoot, `runtime/bun${windows ? ".exe" : ""}`), 0o755);
    for (const [name, path] of Object.entries(native.licenses)) {
      await cp(path, resolve(packageRoot, "licenses", name));
    }
    await writeJson(
      resolve(assets, "app.json"),
      server ? { ...project.app, home: server.url, development: { url: server.url } } : project.app,
    );
    await writeJson(
      resolve(assets, "policy.json"),
      server ? developmentPolicy(project.policy, project.app.view, server.url) : project.policy,
    );
    await writeFile(resolve(assets, "bunfig.toml"), "env = false\n");
    await writeJson(resolve(assets, "tsconfig.json"), {});
    if (!windows)
      for (const schema of await files(resolve(root, "native/host-api/generated"))) {
        await cp(schema, resolve(assets, basename(schema)));
      }
    await bundleAssets(project, assets, windows, !!server);
    signal?.throwIfAborted();
    if (windows) {
      if (!native.loader) throw new Error("Windows requires the pinned WebView2Loader DLL.");
      const deps = (await json(resolve(root, "native/windows/bun/deps.json"))) as {
        webview2Sdk: { files: Record<string, string> };
      };
      await verifyHash(
        native.loader,
        deps.webview2Sdk.files["build/native/x64/WebView2Loader.dll"] ?? "",
      );
      await cp(native.loader, resolve(assets, "WebView2Loader.dll"));
      await writeWindowsLauncher(
        resolve(root, "native/windows/bun/launch.ps1"),
        resolve(packageRoot, "launch.ps1"),
      );
      await writeFile(
        resolve(packageRoot, "bunaway.cmd"),
        '@echo off\r\n"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0launch.ps1" %*\r\n',
      );
    }
    const hashes: Record<string, string> = {};
    for (const dir of ["assets", "licenses"]) {
      for (const file of await files(resolve(packageRoot, dir))) {
        hashes[relative(packageRoot, file).replaceAll("\\", "/")] = await hash(file);
      }
    }
    const framework = (await json(resolve(root, "package.json"))) as { version: string };
    const appPackage = (await json(resolve(project.root, "package.json"))) as { version: string };
    await writeJson(resolve(packageRoot, "manifest.json"), {
      ...pin,
      assets: hashes,
      app: { id: project.app.appId, version: appPackage.version },
      framework: { version: framework.version },
      host: {
        target,
        ...(windows
          ? { kind: "bun-ffi", sha256: await hash(resolve(assets, "boot.js")) }
          : { sourceSha256: await hash(native.host) }),
      },
    });
    if (!windows) {
      await writeFile(
        resolve(staging, "Contents/Info.plist"),
        `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>bunaway-host</string>
<key>CFBundleIdentifier</key><string>${xml(project.app.appId)}</string>
<key>CFBundleName</key><string>${xml(project.app.title)}</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${xml(appPackage.version)}</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>NSPrincipalClass</key><string>NSApplication</string>
${server ? "<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>" : ""}
</dict></plist>\n`,
      );
      const args = ["/usr/bin/codesign", "--force", "--sign", "-", staging];
      if (signal) await runManagedCommand(args, project.root, {}, signal, root);
      else await run(args, project.root);
      await verifyHash(resolve(packageRoot, "runtime/bun"), pin.bun.executableSha256);
    }
    signal?.throwIfAborted();
    await ownedDirectory(project.root, output);
    if (windows && !options.development) {
      // Channel packages live inside the Windows build output, but survive rebuilds.
      const packaged = resolve(output, "packaged");
      const previous = await ownedDirectory(project.root, packaged);
      if (previous) {
        await mkdir(resolve(staging, "packaged"), { recursive: true });
        for (const entry of await readdir(packaged)) {
          if (
            PACKAGING_CHANNELS.some(
              (channel) => entry === channel || entry === `${channel}-report.json`,
            )
          ) {
            const source = resolve(packaged, entry);
            const destination = resolve(staging, "packaged", entry);
            const info = await lstat(source);
            if (
              info.isSymbolicLink() ||
              !(entry.endsWith("-report.json") ? info.isFile() : info.isDirectory())
            ) {
              throw new Error(`Packaged output must be a regular file or directory: ${source}`);
            }
            // Move the existing tree so Windows junctions never need to be recreated.
            await rename(source, destination);
            preserved.push({ source, destination });
          }
        }
      }
    }
    signal?.throwIfAborted();
    const backup = `${output}.previous-${crypto.randomUUID()}`;
    let moved = false;
    await ownedDirectory(project.root, dirname(output));
    try {
      try {
        await rename(output, backup);
        moved = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await rename(staging, output);
      published = true;
    } catch (error) {
      if (moved) {
        await ownedDirectory(project.root, dirname(output));
        await rename(backup, output);
      }
      throw error;
    }
    if (moved) {
      await ownedDirectory(project.root, dirname(backup));
      await rm(backup, { recursive: true, force: true });
    }
    return {
      output,
      package: windows ? output : resolve(output, "Contents/Resources"),
      executable: windows
        ? resolve(output, "runtime/bun.exe")
        : resolve(output, "Contents/MacOS/bunaway-host"),
      arguments: windows
        ? [
            "--no-env-file",
            "--no-install",
            `--config=${resolve(output, "assets/bunfig.toml")}`,
            `--tsconfig-override=${resolve(output, "assets/tsconfig.json")}`,
            resolve(output, "assets/boot.js"),
            ...(server ? ["--dev-url", server.url] : []),
          ]
        : [
            "--package",
            resolve(output, "Contents/Resources"),
            ...(server ? ["--dev-url", server.url] : []),
          ],
    };
  } catch (error) {
    if (!published) {
      for (const { source, destination } of preserved.reverse()) {
        await ownedDirectory(project.root, dirname(source));
        await ownedDirectory(project.root, dirname(destination));
        await rename(destination, source);
      }
    }
    await ownedDirectory(project.root, dirname(staging));
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}
