import { cp, mkdir } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { PROCESS_IPC_VERSION, PROTOCOL_VERSION } from "@bunaway/protocol";
import {
  files,
  frameworkRoot,
  hash,
  installedPackageRoot,
  isOptionalDependency,
  json,
  type PackageDependencies,
  verifyHash,
} from "./files.ts";
import { type InstalledPlugin, installedPlugins } from "./plugins.ts";
import { runWorker } from "./processes.ts";
import type { SourceDependencies } from "./sdk.ts";
import { templateNames } from "./templates.ts";

/** Framework-owned files copied into a distributable CLI artifact. */
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
  "docs/decisions/0010-windows-first-platform-model.md",
  "docs/decisions/0012-integrated-app-build.md",
  "docs/decisions/0013-desktop-lifecycle.md",
  "docs/decisions/0013-optional-native-plugins.md",
  "docs/decisions/0014-optional-plugin-packages.md",
  "docs/decisions/0015-macos-bun-ffi.md",
  "docs/architecture/macos-bun-results.md",
  "docs/architecture/plugins.md",
  "docs/development-server.md",
  "docs/architecture/windows-bun-results.md",
  "docs/platform-support/README.md",
  "tsconfig.base.json",
  "package.json",
  "native/host-api/generated",
  "native/windows/bun/boot.ts",
  "native/windows/bun/config.ts",
  "native/windows/bun/entry.ts",
  "native/windows/bun/development-app.ts",
  "native/windows/bun/app-reload.ts",
  "native/windows/bun/job.ts",
  "native/windows/bun/instance.ts",
  "native/windows/bun/desktop.ts",
  "native/windows/bun/tray.ts",
  "native/windows/bun/deps.json",
  "native/windows/bun/channel.ts",
  "native/windows/bun/ui.ts",
  "native/windows/bun/webview.ts",
  "native/windows/bun/view-profile.ts",
  "native/windows/bun/web-assets.ts",
  "native/windows/bun/com.ts",
  "native/windows/bun/win32.ts",
  "native/windows/bun/win32-bindings.ts",
  "native/windows/bun/window-size.ts",
  "native/windows/bun/plugins.ts",
  "native/windows/bun/plugin-contract.ts",
  "native/windows/bun/plugin-catalog.ts",
  "native/windows/bun/plugin-imports.d.ts",
  "native/windows/bun/host-operations.ts",
  "native/windows/bun/host-response.ts",
  "native/windows/bun/README.md",
  ...[
    "boot.ts",
    "entry.ts",
    "backend.ts",
    "config.ts",
    "process-group.ts",
    "objc.ts",
    "webview.ts",
    "urls.ts",
    "entitlements.plist",
    "README.md",
  ].map((name) => `native/macos/bun/${name}`),
  "runtime/build-manifests",
] as const;

const generatedDirectories = [
  "node_modules",
  "build",
] as const;

/** Version and protocol pins that keep the CLI, SDK packages and native hosts aligned. */
export interface Release {
  format: number;
  version: string;
  packages: Record<string, string>;
  plugins: Record<string, string>;
  webProtocol: {
    major: number;
    minor: number;
  };
  processProtocol: {
    major: number;
    minor: number;
  };
  nativeHost: string;
  bun: string;
}

const packageNames: Record<string, string> = {
  cli: "@bunaway/cli",
  "backend-sdk": "@bunaway/backend",
  "client-sdk": "@bunaway/client",
  "plugin-sdk": "@bunaway/plugin",
  "plugin-api": "@bunaway/plugin-api",
  core: "@bunaway/core",
  protocol: "@bunaway/protocol",
  "runtime-bun": "@bunaway/runtime-bun",
  packaging: "@bunaway/packaging",
};

function sdkDependencies(pkg: PackageDependencies): [
  string,
  string,
][] {
  return [
    pkg.dependencies,
    pkg.devDependencies,
    pkg.optionalDependencies,
    pkg.peerDependencies,
  ]
    .flatMap((dependencies) => Object.entries(dependencies ?? {}))
    .filter(([name]) => name.startsWith("@bunaway/"));
}

/** Detect framework package selectors nested anywhere in package-manager override rules. */
function hasSdkOverride(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    Object.entries(value).some(
      ([selector, rule]) =>
        selector.includes("@bunaway/") || hasSdkOverride(rule),
    )
  );
}

/** Read release metadata and reject mismatched packages, protocols or Bun pins. */
export async function release(root = frameworkRoot): Promise<Release> {
  const value = (await json(resolve(root, "framework.json"))) as Release;
  if (
    value.format !== 1 ||
    !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(value.version) ||
    value.nativeHost !== value.version ||
    !value.packages ||
    !value.plugins ||
    Object.entries(value.plugins).some(
      ([directory, name]) =>
        !/^[a-z-]+$/.test(directory) || name !== `@bunaway/plugin-${directory}`,
    ) ||
    Object.keys(value.packages).length !== Object.keys(packageNames).length ||
    Object.entries(packageNames).some(
      ([directory, name]) => value.packages[directory] !== name,
    ) ||
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
    if (!/^[a-z-]+$/.test(directory)) {
      throw new Error("Invalid framework package directory.");
    }
    const pkg = (await json(
      resolve(root, `packages/${directory}/package.json`),
    )) as {
      name: string;
      version: string;
    };
    if (pkg.name !== name || pkg.version !== value.version) {
      throw new Error(
        `Incompatible SDK/CLI package: ${name}; expected ${value.version}.`,
      );
    }
  }
  for (const target of [
    "windows-x64",
    "darwin-aarch64",
  ]) {
    const pin = (await json(
      resolve(root, `runtime/build-manifests/${target}.json`),
    )) as {
      bun: {
        version: string;
      };
    };
    if (pin.bun.version !== value.bun) {
      throw new Error(`Incompatible Bun pin: ${target}.`);
    }
  }
  return value;
}

/** Copy framework files and package sources, filtering local build and vendor directories from package copies. */
export async function copyFramework(destination: string): Promise<void> {
  const info = await release();
  await mkdir(destination, {
    recursive: true,
  });
  for (const name of frameworkPaths) {
    await cp(resolve(frameworkRoot, name), resolve(destination, name), {
      recursive: true,
    });
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

/** Return SHA-256 hashes keyed by normalized paths relative to the artifact root. */
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

/** Validate framework versions and dependencies, and app imports when source paths are supplied. */
export async function validateFramework(
  project: string,
  sources: readonly string[] = [],
): Promise<
  SourceDependencies & {
    root: string;
    plugins: InstalledPlugin[];
  }
> {
  const pkg = (await json(
    resolve(project, "package.json"),
  )) as PackageDependencies & {
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
    throw new Error(
      "Incompatible framework/CLI; use the project's installed bunaway command.",
    );
  }
  if (pkg.packageManager !== `bun@${actual.bun}`) {
    throw new Error(
      "Incompatible Bun/SDK dependency declaration; use the pinned Bun version.",
    );
  }
  // Check release integrity before resolving app imports against the installed artifact.
  await checkArtifact(root);
  // Collect package roots from app declarations and installed package manifests for import resolution.
  const declarations = sdkDependencies(pkg);
  const references: {
    name: string;
    parent: string;
  }[] = [];
  for (const name of Object.values(packageNames)) {
    // The CLI declares all SDKs; transitive packages need not be hoisted into the app.
    const installed =
      name === "@bunaway/cli" ? root : await installedPackageRoot(root, name);
    const manifest = (await json(
      resolve(installed, "package.json"),
    )) as PackageDependencies & {
      name: string;
      version: string;
    };
    if (manifest.name !== name || manifest.version !== actual.version) {
      throw new Error(
        `Incompatible SDK/CLI package: ${name}; expected ${actual.version}.`,
      );
    }
    for (const [dependency, version] of sdkDependencies(manifest)) {
      if (version !== actual.version && !version.endsWith(".tgz")) {
        throw new Error(`Incompatible SDK dependency: ${dependency}.`);
      }
      if (dependency !== "@bunaway/cli") {
        references.push({
          name: dependency,
          parent: installed,
        });
      }
    }
    if (
      name !== "@bunaway/cli" &&
      declarations.some(([dependency]) => dependency === name)
    ) {
      for (const parent of [
        project,
        ...sources,
      ]) {
        references.push({
          name,
          parent,
        });
      }
    }
  }
  for (const name of [
    "@bunaway/cli",
    "@bunaway/backend",
    "@bunaway/client",
    "@bunaway/runtime-bun",
  ]) {
    if (!declarations.some(([dependency]) => dependency === name)) {
      throw new Error(
        `Missing framework dependency: ${name}; follow the installation guide.`,
      );
    }
  }
  const plugins = await installedPlugins(project, actual.version);
  // Reject SDK and plugin declarations that are outside this release or pinned to another version.
  for (const [name, specifier] of declarations) {
    if (
      !Object.values(packageNames).includes(name) &&
      !plugins.some((plugin) => plugin.packageName === name) &&
      isOptionalDependency(pkg, name)
    ) {
      try {
        await installedPackageRoot(project, name);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          continue;
        }
        throw error;
      }
    }
    if (
      (!Object.values(packageNames).includes(name) &&
        !plugins.some((plugin) => plugin.packageName === name)) ||
      (specifier !== actual.version && !specifier.endsWith(".tgz"))
    ) {
      throw new Error(
        `Incompatible Bun/SDK dependency declaration: ${name}; pin ${actual.version}.`,
      );
    }
  }
  // Resolve imports in Bun's worker so the result reflects the app's installed package graph.
  const output = await runWorker(
    "sdk.ts",
    "validateSdkGraph",
    [
      project,
      references,
      sources,
      plugins,
    ],
    project,
    root,
  );
  return {
    root,
    ...(JSON.parse(output) as SourceDependencies),
    plugins,
  };
}

/** Build the local tarball filename used for a framework package and version. */
export function packageFilename(name: string, version: string): string {
  return `${name.replace("@bunaway/", "bunaway-")}-${version}.tgz`;
}

function requiredFrameworkFiles(): string[] {
  return [
    ...frameworkPaths.filter(
      (path) =>
        ![
          "native/host-api/generated",
          "licenses",
          "runtime/build-manifests",
        ].includes(path),
    ),
    "licenses/LICENSE.bun",
    "licenses/LICENSE.nlohmann-json",
    "licenses/License-WebView2.txt",
    ...[
      "bootstrap",
      "host-call",
      "host-response",
      "message",
      "policy",
      "process",
    ].map((name) => `native/host-api/generated/${name}.schema.json`),
    "runtime/build-manifests/windows-x64.json",
    "runtime/build-manifests/darwin-aarch64.json",
    "packages/cli/src/assets.ts",
    "packages/cli/src/app-modules.ts",
    "packages/cli/src/sdk.ts",
    "packages/cli/src/plugins.ts",
    "packages/cli/src/dev-server.ts",
    "packages/cli/src/dev-server-worker.ts",
    "packages/cli/src/frontend-build.ts",
    "packages/cli/src/managed-command.ts",
    "packages/cli/src/native-build.ts",
    "packages/cli/src/processes.ts",
    "packages/cli/src/windows-compile.ts",
    "packages/cli/src/macos-compile.ts",
    "packages/cli/src/windows-dev-launch.ts",
    "packages/runtime-bun/src/development.ts",
    "packages/runtime-bun/src/window-config.ts",
    "packages/runtime-bun/src/windows-control.ts",
    "packages/packaging/src/paths.ts",
    ...Object.keys(packageNames).flatMap((directory) =>
      [
        "package.json",
        "src/index.ts",
        "tsconfig.json",
      ].map((name) => `packages/${directory}/${name}`),
    ),
  ];
}

/** Verify artifact contents, required inputs and pinned third-party license files. */
export async function checkArtifact(root: string): Promise<void> {
  await release(root);
  const inventory = (await json(
    resolve(root, "artifact.files.json"),
  )) as Record<string, string>;
  const actual = await snapshotHashes(root, generatedDirectories);
  // Exclude the inventory itself because embedding its own hash would make it self-referential.
  delete actual["artifact.files.json"];
  const mismatches = [
    ...new Set([
      ...Object.keys(actual),
      ...Object.keys(inventory),
    ]),
  ]
    .filter((name) => actual[name] !== inventory[name])
    .sort();
  if (mismatches.length) {
    throw new Error(
      `Artifact inventory mismatch: missing, extra or modified file: ${mismatches.join(", ")}.`,
    );
  }
  // Check required source, generated bundles and template files after the inventory matches.
  for (const name of [
    ...requiredFrameworkFiles(),
    "packages/cli/dist/distribution-main.js",
    "packages/cli/dist/index.js",
    "packages/cli/dist/types/cli/src/index.d.ts",
    ...templateNames.flatMap((template) =>
      [
        "package.json",
        "gitattributes",
        "gitignore",
        "README.md",
        "tsconfig.json",
        "src-bunaway/bunaway.json",
        "src-bunaway/policy.json",
        "src-bunaway/app.ts",
        "src-bunaway/tsconfig.json",
        "src-bunaway/message/module.ts",
        "src/client.ts",
      ].map((name) => `packages/cli/templates/${template}/${name}`),
    ),
    ...Object.entries({
      vanilla: [
        "src/index.html",
        "src/main.ts",
        "src/style.css",
      ],
      vite: [
        "src/main.ts",
        "src/style.css",
        "src/counter.ts",
        "src/assets/typescript.svg",
      ],
      react: [
        "src/main.tsx",
        "src/App.tsx",
        "src/App.css",
        "src/index.css",
        "src/assets/react.svg",
      ],
      vue: [
        "src/main.ts",
        "src/App.vue",
        "src/style.css",
        "src/components/HelloWorld.vue",
        "src/assets/vue.svg",
      ],
      svelte: [
        "src/main.ts",
        "src/App.svelte",
        "src/app.css",
        "src/lib/Counter.svelte",
        "src/assets/svelte.svg",
        "svelte.config.js",
        "tsconfig.node.json",
      ],
    }).flatMap(([template, names]) =>
      names.map((name) => `packages/cli/templates/${template}/${name}`),
    ),
    ...templateNames
      .filter((template) => template !== "vanilla")
      .flatMap((template) =>
        [
          "vite.config.ts",
          "index.html",
          "src/assets/hero.png",
          "src/assets/vite.svg",
          "public/favicon.svg",
          "public/icons.svg",
          "public/LICENSE.vite.txt",
        ].map((name) => `packages/cli/templates/${template}/${name}`),
      ),
  ]) {
    if (!inventory[name]) {
      throw new Error(`Artifact is missing required input: ${name}`);
    }
  }
  const pin = (await json(
    resolve(root, "runtime/build-manifests/windows-x64.json"),
  )) as {
    bun: {
      licenseSha256: string;
    };
  };
  await verifyHash(
    resolve(root, "licenses/LICENSE.bun"),
    pin.bun.licenseSha256,
  );
  const macPin = (await json(
    resolve(root, "runtime/build-manifests/darwin-aarch64.json"),
  )) as {
    json: {
      licenseSha256: string;
    };
  };
  await verifyHash(
    resolve(root, "licenses/LICENSE.nlohmann-json"),
    macPin.json.licenseSha256,
  );
  const deps = (await json(resolve(root, "native/windows/bun/deps.json"))) as {
    webview2Sdk: {
      files: Record<string, string>;
    };
  };
  await verifyHash(
    resolve(root, "licenses/License-WebView2.txt"),
    deps.webview2Sdk.files["LICENSE.txt"] ?? "",
  );
}
