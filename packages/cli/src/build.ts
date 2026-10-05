import { chmod, cp, mkdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import { validateProject, type Project } from "./config.ts";
import { files, frameworkRoot, hash, json, run, verifyHash, writeJson } from "./files.ts";

export type Target = "windows-x64" | "macos-arm64";
export interface NativeInputs {
  target: Target;
  host: string;
  bun: string;
  licenses: Record<string, string>;
}
interface Pin {
  bun: { version: string; target: string; executableSha256: string; licenseSha256: string };
  json: { licenseSha256: string };
}
export interface BuiltPackage {
  output: string;
  package: string;
  executable: string;
}

export function currentTarget(): Target {
  if (process.platform === "win32" && process.arch === "x64") return "windows-x64";
  if (process.platform === "darwin" && process.arch === "arm64") return "macos-arm64";
  throw new Error("MVP builds require Windows x64 or macOS arm64 (native builds only).");
}

async function readPin(target: Target): Promise<Pin> {
  return (await json(
    resolve(
      frameworkRoot,
      "runtime/build-manifests",
      target === "windows-x64" ? "windows-x64.json" : "darwin-aarch64.json",
    ),
  )) as Pin;
}

export async function assertBuildBun(target: Target): Promise<void> {
  if (Bun.version !== (await readPin(target)).bun.version) {
    throw new Error("Development/build Bun must match the pinned version (1.4.2).");
  }
}

export async function prepareNative(target: Target = currentTarget()): Promise<NativeInputs> {
  if (target !== currentTarget()) throw new Error("Cross compilation is not supported in the MVP.");
  await assertBuildBun(target);
  const windows = target === "windows-x64";
  await run(
    windows
      ? [
          "pwsh",
          "-NoProfile",
          "-File",
          resolve(frameworkRoot, "native/windows/host/run.ps1"),
          "-BuildHostOnly",
          "-Bun",
          process.execPath,
        ]
      : ["zsh", resolve(frameworkRoot, "native/macos/host/run.sh"), "--host-only"],
    frameworkRoot,
    { BUN: process.execPath },
  );
  const pin = await readPin(target);
  const vendor = resolve(frameworkRoot, "runtime/bun-bundle/vendor");
  const licenses: Record<string, string> = {
    "LICENSE.bun": resolve(vendor, "LICENSE.bun"),
    "LICENSE.nlohmann-json": resolve(
      frameworkRoot,
      `native/${windows ? "windows" : "macos"}/vendor/LICENSE.nlohmann-json`,
    ),
  };
  if (windows)
    licenses["License-WebView2.txt"] = resolve(
      frameworkRoot,
      "native/windows/host/vendor/webview2/License-WebView2.txt",
    );
  return {
    target,
    host: resolve(
      frameworkRoot,
      `build/${windows ? "windows" : "macos"}-host/bunaway-host${windows ? ".exe" : ""}`,
    ),
    bun: resolve(vendor, `bun-${pin.bun.target}/bun${windows ? ".exe" : ""}`),
    licenses,
  };
}

async function bundle(
  entrypoints: string[],
  outdir: string,
  target: "browser" | "bun",
  root: string,
): Promise<void> {
  if (entrypoints.length === 0) return;
  const result = await Bun.build({ entrypoints, outdir, root, target, splitting: false });
  if (!result.success) {
    throw new Error(`Bundle failed:\n${result.logs.map(String).join("\n")}`);
  }
}

async function webAssets(project: Project, destination: string): Promise<void> {
  const sources = await files(project.frontend);
  const entries: string[] = [];
  const outputs = new Set<string>();
  for (const source of sources) {
    const rel = relative(project.frontend, source);
    if (rel.endsWith(".d.ts")) continue;
    const isEntry = /\.(ts|js)$/.test(rel);
    const out = isEntry ? rel.replace(/\.ts$/, ".js") : rel;
    if (outputs.has(out)) throw new Error(`Frontend output collision: ${out}`);
    outputs.add(out);
    if (isEntry) entries.push(source);
    else {
      await mkdir(dirname(resolve(destination, out)), { recursive: true });
      await cp(source, resolve(destination, out));
    }
  }
  await bundle(entries, destination, "browser", project.frontend);
}

export async function bundleAssets(project: Project, assets: string): Promise<void> {
  await webAssets(project, resolve(assets, "web"));
  const backend = await Bun.build({
    entrypoints: [project.backend],
    target: "bun",
    packages: "bundle",
  });
  if (!backend.success || backend.outputs.length !== 1) {
    throw new Error(`Backend bundle failed:\n${backend.logs.map(String).join("\n")}`);
  }
  const backendOutput = backend.outputs[0];
  if (!backendOutput) throw new Error("Missing backend bundle.");
  await Bun.write(resolve(assets, "backend.js"), backendOutput);
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
  const project = await validateProject(directory);
  const target = options.native?.target ?? currentTarget();
  await assertBuildBun(target);
  const native = options.native ?? (await prepareNative(target));
  const windows = target === "windows-x64";
  const pin = await readPin(target);
  await verifyHash(native.bun, pin.bun.executableSha256);
  await verifyHash(native.licenses["LICENSE.bun"] ?? "", pin.bun.licenseSha256);
  await verifyHash(native.licenses["LICENSE.nlohmann-json"] ?? "", pin.json.licenseSha256);
  if (windows) {
    const deps = (await json(resolve(frameworkRoot, "native/windows/host/deps.json"))) as {
      webview2Sdk: { files: Record<string, string> };
    };
    await verifyHash(
      native.licenses["License-WebView2.txt"] ?? "",
      deps.webview2Sdk.files["LICENSE.txt"] ?? "",
    );
  }
  await stat(native.host);
  const parent = resolve(project.root, options.development ? ".bunaway" : "dist");
  await mkdir(parent, { recursive: true });
  const output = resolve(parent, `${target}${windows ? "" : `/${project.app.appId}.app`}`);
  await mkdir(dirname(output), { recursive: true });
  const staging = `${output}.building-${crypto.randomUUID()}`;
  const packageRoot = windows ? staging : resolve(staging, "Contents/Resources");
  const executable = windows
    ? resolve(staging, "bunaway-host.exe")
    : resolve(staging, "Contents/MacOS/bunaway-host");
  try {
    const assets = resolve(packageRoot, "assets");
    await mkdir(resolve(assets, "web"), { recursive: true });
    await mkdir(resolve(packageRoot, "runtime"), { recursive: true });
    await mkdir(resolve(packageRoot, "licenses"), { recursive: true });
    await mkdir(dirname(executable), { recursive: true });
    await cp(native.host, executable);
    await cp(native.bun, resolve(packageRoot, `runtime/bun${windows ? ".exe" : ""}`));
    await chmod(executable, 0o755);
    await chmod(resolve(packageRoot, `runtime/bun${windows ? ".exe" : ""}`), 0o755);
    for (const [name, path] of Object.entries(native.licenses)) {
      await cp(path, resolve(packageRoot, "licenses", name));
    }
    await writeJson(resolve(assets, "app.json"), project.app);
    await writeJson(resolve(assets, "policy.json"), project.policy);
    await Bun.write(resolve(assets, "bunfig.toml"), "env = false\n");
    await writeJson(resolve(assets, "tsconfig.json"), {});
    for (const schema of await files(resolve(frameworkRoot, "native/host-api/generated"))) {
      await cp(schema, resolve(assets, basename(schema)));
    }
    await bundleAssets(project, assets);
    const hashes: Record<string, string> = {};
    for (const dir of ["assets", "licenses"]) {
      for (const file of await files(resolve(packageRoot, dir))) {
        hashes[relative(packageRoot, file).replaceAll("\\", "/")] = await hash(file);
      }
    }
    const framework = (await json(resolve(frameworkRoot, "package.json"))) as { version: string };
    const appPackage = (await json(resolve(project.root, "package.json"))) as { version: string };
    await writeJson(resolve(packageRoot, "manifest.json"), {
      ...pin,
      assets: hashes,
      app: { id: project.app.appId, version: appPackage.version },
      framework: { version: framework.version },
      host: { target, sha256: await hash(executable) },
    });
    if (!windows) {
      await Bun.write(
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
</dict></plist>\n`,
      );
      await run(["/usr/bin/codesign", "--force", "--deep", "--sign", "-", staging], project.root);
    }
    const backup = `${output}.previous-${crypto.randomUUID()}`;
    let moved = false;
    try {
      try {
        await rename(output, backup);
        moved = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await rename(staging, output);
    } catch (error) {
      if (moved) await rename(backup, output);
      throw error;
    }
    if (moved) await rm(backup, { recursive: true, force: true });
    return {
      output,
      package: windows ? output : resolve(output, "Contents/Resources"),
      executable: windows
        ? resolve(output, "bunaway-host.exe")
        : resolve(output, "Contents/MacOS/bunaway-host"),
    };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}
