import { cp, mkdir } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { PROCESS_IPC_VERSION, PROTOCOL_VERSION } from "@bunaway/protocol";
import {
  files,
  frameworkRoot,
  hash,
  json,
  installedPackageRoot,
  runWorker,
  verifyHash,
} from "./files.ts";

export const frameworkPaths = [
  "framework.json",
  "FRAMEWORK-LICENSE.txt",
  "THIRD-PARTY-NOTICES.txt",
  "licenses",
  "docs/framework-distribution.md",
  "docs/decisions/0005-framework-artifact.md",
  "docs/decisions/0007-project-settings.md",
  "docs/decisions/0008-installed-framework-packages.md",
  "docs/decisions/0001-bundled-bun-process.md",
  "docs/decisions/0006-windows-bun-ui-worker.md",
  "docs/decisions/0009-development-server.md",
  "docs/development-server.md",
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
  "node_modules",
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
      "Incompatible framework/native host/Web/IPC release; install one matching package release.",
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

export async function validateFramework(
  project: string,
  sources: readonly string[] = [],
): Promise<string> {
  const pkg = (await json(resolve(project, "package.json"))) as PackageDependencies & {
    packageManager: string;
    overrides?: unknown;
    resolutions?: unknown;
  };
  if (hasSdkOverride(pkg.overrides) || hasSdkOverride(pkg.resolutions)) {
    throw new Error(
      "Incompatible Bun/SDK dependency override; install one matching framework release.",
    );
  }
  const root = await installedPackageRoot(project, "@bunaway/cli");
  const actual = await release(root);
  const active = await release();
  if (actual.version !== active.version) {
    throw new Error("Incompatible framework/CLI; use the project's installed bunaway command.");
  }
  if (pkg.packageManager !== `bun@${actual.bun}`) {
    throw new Error("Incompatible Bun/SDK dependency declaration; use the pinned Bun version.");
  }
  await checkArtifact(root);
  const declarations = sdkDependencies(pkg);
  const references: { name: string; parent: string }[] = [];
  for (const name of Object.values(packageNames)) {
    // The CLI declares all SDKs; transitive packages need not be hoisted into the app.
    const installed = name === "@bunaway/cli" ? root : await installedPackageRoot(root, name);
    const manifest = (await json(resolve(installed, "package.json"))) as PackageDependencies & {
      name: string;
      version: string;
    };
    if (manifest.name !== name || manifest.version !== actual.version) {
      throw new Error(`Incompatible SDK/CLI package: ${name}; expected ${actual.version}.`);
    }
    for (const [dependency, version] of sdkDependencies(manifest)) {
      if (version !== actual.version && !version.endsWith(".tgz"))
        throw new Error(`Incompatible SDK dependency: ${dependency}.`);
      if (dependency !== "@bunaway/cli") references.push({ name: dependency, parent: installed });
    }
    if (name !== "@bunaway/cli" && declarations.some(([dependency]) => dependency === name)) {
      for (const parent of [project, ...sources]) references.push({ name, parent });
    }
  }
  for (const name of [
    "@bunaway/cli",
    "@bunaway/backend",
    "@bunaway/client",
    "@bunaway/runtime-bun",
  ]) {
    if (!declarations.some(([dependency]) => dependency === name)) {
      throw new Error(`Missing framework dependency: ${name}; follow the installation guide.`);
    }
  }
  for (const [name, specifier] of declarations) {
    if (
      !Object.values(packageNames).includes(name) ||
      (specifier !== actual.version && !specifier.endsWith(".tgz"))
    ) {
      throw new Error(
        `Incompatible Bun/SDK dependency declaration: ${name}; pin ${actual.version}.`,
      );
    }
  }
  await runWorker("sdk.ts", "validateSdkGraph", [project, references, sources], project, root);
  return root;
}

export function packageFilename(name: string, version: string): string {
  return `${name.replace("@bunaway/", "bunaway-")}-${version}.tgz`;
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
    "packages/cli/src/dev-server.ts",
    "packages/cli/src/dev-server-worker.ts",
    "packages/runtime-bun/src/development.ts",
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
  const mismatches = [...new Set([...Object.keys(actual), ...Object.keys(inventory)])]
    .filter((name) => actual[name] !== inventory[name])
    .sort();
  if (mismatches.length) {
    throw new Error(
      `Artifact inventory mismatch: missing, extra or modified file: ${mismatches.join(", ")}.`,
    );
  }
  for (const name of [
    ...requiredFrameworkFiles(),
    "packages/cli/dist/distribution-main.js",
    "packages/cli/dist/index.js",
    "packages/cli/dist/types/cli/src/index.d.ts",
    "packages/cli/templates/vanilla/package.json",
    "packages/cli/templates/vanilla/gitattributes",
    ...[
      "package.json",
      "src-bunaway/bunaway.json",
      "vite.config.ts",
      "index.html",
      "README.md",
      "gitignore",
      "tsconfig.json",
    ].map((name) => `packages/cli/templates/vite/${name}`),
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
