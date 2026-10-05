import { cp, mkdir, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { PROCESS_IPC_VERSION, PROTOCOL_VERSION } from "@bunaway/protocol";
import { files, frameworkRoot, hash, json, projectPath, verifyHash, writeJson } from "./files.ts";

export const frameworkPaths = [
  "framework.json",
  "FRAMEWORK-LICENSE.txt",
  "THIRD-PARTY-NOTICES.txt",
  "licenses",
  "docs/framework-distribution.md",
  "docs/decisions/0005-framework-artifact.md",
  "docs/decisions/0001-bundled-bun-process.md",
  "docs/platform-support/README.md",
  "tsconfig.base.json",
  "package.json",
  "native/host-api/generated",
  "native/windows/host/host.cpp",
  "native/windows/host/CMakeLists.txt",
  "native/windows/host/deps.json",
  "native/windows/host/run.ps1",
  "native/macos/host/main.mm",
  "native/macos/host/run.sh",
  "runtime/build-manifests",
] as const;

export interface Release {
  format: number;
  version: string;
  packages: Record<string, string>;
  webProtocol: { major: number; minor: number };
  processProtocol: { major: number; minor: number };
  nativeHost: string;
  bun: string;
}

const packageNames: Record<string, string> = {
  cli: "@bunaway/cli",
  "backend-sdk": "@bunaway/backend",
  "client-sdk": "@bunaway/client",
  core: "@bunaway/core",
  protocol: "@bunaway/protocol",
  "runtime-bun": "@bunaway/runtime-bun",
};

export async function release(root = frameworkRoot): Promise<Release> {
  const value = (await json(resolve(root, "framework.json"))) as Release;
  if (
    value.format !== 1 ||
    !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(value.version) ||
    value.nativeHost !== value.version ||
    !value.packages ||
    Object.keys(value.packages).length !== Object.keys(packageNames).length ||
    Object.entries(packageNames).some(([directory, name]) => value.packages[directory] !== name) ||
    value.webProtocol?.major !== PROTOCOL_VERSION.major ||
    value.webProtocol?.minor !== PROTOCOL_VERSION.minor ||
    value.processProtocol?.major !== PROCESS_IPC_VERSION.major ||
    value.processProtocol?.minor !== PROCESS_IPC_VERSION.minor
  ) {
    throw new Error(
      "Incompatible framework/native host/Web/IPC release; upgrade the whole snapshot.",
    );
  }
  for (const [directory, name] of Object.entries(value.packages)) {
    if (!/^[a-z-]+$/.test(directory)) throw new Error("Invalid framework package directory.");
    const pkg = (await json(resolve(root, `packages/${directory}/package.json`))) as {
      name: string;
      version: string;
    };
    if (pkg.name !== name || pkg.version !== value.version) {
      throw new Error(`Incompatible SDK/CLI package: ${name}; expected ${value.version}.`);
    }
  }
  for (const target of ["windows-x64", "darwin-aarch64"]) {
    const pin = (await json(resolve(root, `runtime/build-manifests/${target}.json`))) as {
      bun: { version: string };
    };
    if (pin.bun.version !== value.bun) throw new Error(`Incompatible Bun pin: ${target}.`);
  }
  return value;
}

export async function copyFramework(destination: string): Promise<void> {
  const info = await release();
  await mkdir(destination, { recursive: true });
  for (const name of frameworkPaths) {
    await cp(resolve(frameworkRoot, name), resolve(destination, name), { recursive: true });
  }
  for (const directory of Object.keys(info.packages)) {
    const source = resolve(frameworkRoot, `packages/${directory}`);
    await cp(source, resolve(destination, `packages/${directory}`), {
      recursive: true,
      filter: (path) =>
        !/(^|[\\/])(node_modules|vendor|build|dist|\.git|\.env[^\\/]*)([\\/]|$)/.test(
          relative(source, path),
        ),
    });
  }
}

export async function snapshotHashes(root: string): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  for (const path of await files(root)) {
    const name = relative(root, path).replaceAll("\\", "/");
    hashes[name] = await hash(path);
  }
  return hashes;
}

export async function writeFrameworkLock(project: string): Promise<void> {
  const root = resolve(project, "vendor/bunaway");
  await writeJson(resolve(project, "bunaway.lock.json"), {
    release: await release(root),
    files: await snapshotHashes(root),
  });
}

export async function validateFramework(project: string): Promise<void> {
  const root = resolve(project, "vendor/bunaway");
  const lockPath = resolve(project, "bunaway.lock.json");
  if (!(await Bun.file(lockPath).exists())) {
    throw new Error(
      "Missing bunaway.lock.json (legacy project). Follow the framework upgrade guide.",
    );
  }
  const lock = (await json(lockPath)) as { release: Release; files: Record<string, string> };
  const actual = await release(root);
  const active = await release();
  if (
    JSON.stringify(lock.release) !== JSON.stringify(actual) ||
    actual.version !== active.version
  ) {
    throw new Error(
      "Incompatible framework snapshot/CLI; use the project's CLI or upgrade the whole snapshot.",
    );
  }
  for (const name of requiredFrameworkFiles()) {
    if (!lock.files[name]) {
      throw new Error(`Framework lock is missing required input: ${name}`);
    }
  }
  for (const [name, expected] of Object.entries(lock.files)) {
    if (name.includes("\\") || name.split("/").includes("..") || name.startsWith("/")) {
      throw new Error("Invalid framework lock path.");
    }
    await verifyHash(await projectPath(root, name), expected);
  }
  const pkg = JSON.parse(await readFile(resolve(project, "package.json"), "utf8")) as {
    dependencies: Record<string, string>;
    workspaces: string[];
    packageManager: string;
  };
  if (
    pkg.packageManager !== `bun@${actual.bun}` ||
    JSON.stringify(pkg.workspaces) !== JSON.stringify(["vendor/bunaway/packages/*"]) ||
    ["@bunaway/backend", "@bunaway/client", "@bunaway/runtime-bun"].some(
      (name) => pkg.dependencies?.[name] !== "workspace:*",
    ) ||
    Object.entries(pkg.dependencies).some(
      ([name, version]) => name.startsWith("@bunaway/") && version !== "workspace:*",
    )
  ) {
    throw new Error(
      "Incompatible Bun/SDK dependency declaration; keep the pinned vendor workspaces.",
    );
  }
}

function requiredFrameworkFiles(): string[] {
  return [
    ...frameworkPaths.filter(
      (path) =>
        !["native/host-api/generated", "licenses", "runtime/build-manifests"].includes(path),
    ),
    "licenses/LICENSE.bun",
    "licenses/LICENSE.nlohmann-json",
    "licenses/License-WebView2.txt",
    ...["bootstrap", "host-call", "host-response", "message", "policy", "process"].map(
      (name) => `native/host-api/generated/${name}.schema.json`,
    ),
    "native/host-api/generated/host-operations.json",
    "runtime/build-manifests/windows-x64.json",
    "runtime/build-manifests/darwin-aarch64.json",
    ...Object.keys(packageNames).flatMap((directory) =>
      ["package.json", "src/index.ts", "tsconfig.json"].map(
        (name) => `packages/${directory}/${name}`,
      ),
    ),
  ];
}

export async function checkArtifact(root: string): Promise<void> {
  await release(root);
  const inventory = (await json(resolve(root, "artifact.files.json"))) as Record<string, string>;
  const actual = await snapshotHashes(root);
  delete actual["artifact.files.json"];
  if (JSON.stringify(actual) !== JSON.stringify(inventory)) {
    throw new Error("Artifact inventory mismatch: missing, extra or modified file.");
  }
  for (const name of [
    ...requiredFrameworkFiles(),
    "packages/cli/dist/distribution-main.js",
    "packages/cli/dist/index.js",
    "packages/cli/templates/vanilla/package.json",
  ]) {
    if (!inventory[name]) throw new Error(`Artifact is missing required input: ${name}`);
  }
  const pin = (await json(resolve(root, "runtime/build-manifests/windows-x64.json"))) as {
    bun: { licenseSha256: string };
    json: { licenseSha256: string };
  };
  await verifyHash(resolve(root, "licenses/LICENSE.bun"), pin.bun.licenseSha256);
  await verifyHash(resolve(root, "licenses/LICENSE.nlohmann-json"), pin.json.licenseSha256);
  const deps = (await json(resolve(root, "native/windows/host/deps.json"))) as {
    webview2Sdk: { files: Record<string, string> };
  };
  await verifyHash(
    resolve(root, "licenses/License-WebView2.txt"),
    deps.webview2Sdk.files["LICENSE.txt"] ?? "",
  );
}
