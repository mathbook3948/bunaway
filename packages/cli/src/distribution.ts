import { cp, mkdir, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { PROCESS_IPC_VERSION, PROTOCOL_VERSION } from "@bunaway/protocol";
import {
  files,
  frameworkRoot,
  hash,
  json,
  projectPath,
  runWorker,
  verifyHash,
  writeJson,
} from "./files.ts";

export const frameworkPaths = [
  "framework.json",
  "FRAMEWORK-LICENSE.txt",
  "THIRD-PARTY-NOTICES.txt",
  "licenses",
  "docs/framework-distribution.md",
  "docs/decisions/0005-framework-artifact.md",
  "docs/decisions/0001-bundled-bun-process.md",
  "docs/decisions/0006-windows-bun-ui-worker.md",
  "docs/architecture/windows-bun-results.md",
  "docs/platform-support/README.md",
  "tsconfig.base.json",
  "package.json",
  "native/host-api/generated",
  "native/windows/bun/boot.ts",
  "native/windows/bun/entry.ts",
  "native/windows/bun/job.ts",
  "native/windows/bun/deps.json",
  "native/windows/bun/channel.ts",
  "native/windows/bun/boundary.ts",
  "native/windows/bun/ui.ts",
  "native/windows/bun/webview.ts",
  "native/windows/bun/com.ts",
  "native/windows/bun/win32.ts",
  "native/windows/bun/storage.ts",
  "native/windows/bun/host-operations.ts",
  "native/windows/bun/log.ts",
  "native/windows/bun/launch.ps1",
  "native/windows/bun/prepare.ps1",
  "native/windows/bun/README.md",
  "native/macos/host/main.mm",
  "native/macos/host/run.sh",
  "runtime/build-manifests",
] as const;

const generatedDirectories = [
  "build",
  "runtime/bun-bundle/vendor",
  "native/windows/bun/vendor",
  "native/macos/vendor",
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
  packaging: "@bunaway/packaging",
};

const snapshotGeneratedDirectories = [
  ...generatedDirectories,
  ...Object.keys(packageNames).map((directory) => `packages/${directory}/node_modules`),
];

interface PackageDependencies {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

function sdkDependencies(pkg: PackageDependencies): [string, string][] {
  return [pkg.dependencies, pkg.devDependencies, pkg.optionalDependencies, pkg.peerDependencies]
    .flatMap((dependencies) => Object.entries(dependencies ?? {}))
    .filter(([name]) => name.startsWith("@bunaway/"));
}

function hasSdkOverride(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    Object.entries(value).some(
      ([selector, rule]) => selector.includes("@bunaway/") || hasSdkOverride(rule),
    )
  );
}

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

export async function snapshotHashes(
  root: string,
  excludedDirectories: readonly string[] = [],
): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  for (const path of await files(root, excludedDirectories)) {
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

export async function validateFramework(
  project: string,
  sources: readonly string[] = [],
): Promise<void> {
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
  for (const path of await files(root, snapshotGeneratedDirectories)) {
    const name = relative(root, path).replaceAll("\\", "/");
    if (!Object.hasOwn(lock.files, name)) {
      throw new Error(`Unexpected framework snapshot file: ${name}`);
    }
  }
  const pkg = JSON.parse(
    await readFile(resolve(project, "package.json"), "utf8"),
  ) as PackageDependencies & {
    workspaces: string[];
    packageManager: string;
    overrides?: unknown;
    resolutions?: unknown;
  };
  if (
    pkg.packageManager !== `bun@${actual.bun}` ||
    JSON.stringify(pkg.workspaces) !== JSON.stringify(["vendor/bunaway/packages/*"]) ||
    ["@bunaway/backend", "@bunaway/client", "@bunaway/runtime-bun"].some(
      (name) => pkg.dependencies?.[name] !== "workspace:*",
    ) ||
    sdkDependencies(pkg).some(([, version]) => version !== "workspace:*") ||
    hasSdkOverride(pkg.overrides) ||
    hasSdkOverride(pkg.resolutions)
  ) {
    throw new Error(
      "Incompatible Bun/SDK dependency declaration; keep the pinned vendor workspaces.",
    );
  }
  const references: { name: string; parent: string }[] = [];
  for (const name of new Set(sdkDependencies(pkg).map(([name]) => name))) {
    for (const parent of [project, ...sources]) {
      references.push({ name, parent });
    }
  }
  for (const directory of Object.keys(packageNames)) {
    const workspace = resolve(root, `packages/${directory}`);
    const manifest = (await json(resolve(workspace, "package.json"))) as PackageDependencies;
    for (const [name] of sdkDependencies(manifest)) {
      references.push({ name, parent: resolve(workspace, "src/index.ts") });
    }
  }
  await runWorker("sdk.ts", "validateSdkGraph", [project, references, sources], project);
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
    "packages/cli/src/assets.ts",
    "packages/cli/src/sdk.ts",
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
  const actual = await snapshotHashes(root, generatedDirectories);
  delete actual["artifact.files.json"];
  if (JSON.stringify(actual) !== JSON.stringify(inventory)) {
    throw new Error("Artifact inventory mismatch: missing, extra or modified file.");
  }
  for (const name of [
    ...requiredFrameworkFiles(),
    "packages/cli/dist/distribution-main.js",
    "packages/cli/dist/index.js",
    "packages/cli/dist/types/cli/src/index.d.ts",
    "packages/cli/templates/vanilla/package.json",
    "packages/cli/templates/vanilla/gitattributes",
  ]) {
    if (!inventory[name]) throw new Error(`Artifact is missing required input: ${name}`);
  }
  const pin = (await json(resolve(root, "runtime/build-manifests/windows-x64.json"))) as {
    bun: { licenseSha256: string };
  };
  await verifyHash(resolve(root, "licenses/LICENSE.bun"), pin.bun.licenseSha256);
  const macPin = (await json(resolve(root, "runtime/build-manifests/darwin-aarch64.json"))) as {
    json: { licenseSha256: string };
  };
  await verifyHash(resolve(root, "licenses/LICENSE.nlohmann-json"), macPin.json.licenseSha256);
  const deps = (await json(resolve(root, "native/windows/bun/deps.json"))) as {
    webview2Sdk: { files: Record<string, string> };
  };
  await verifyHash(
    resolve(root, "licenses/License-WebView2.txt"),
    deps.webview2Sdk.files["LICENSE.txt"] ?? "",
  );
}
