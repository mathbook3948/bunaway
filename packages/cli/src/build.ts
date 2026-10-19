import {
  chmod,
  cp,
  lstat,
  mkdir,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import {
  acquireBuildOutputLock,
  ownedDirectory,
  PACKAGING_CHANNELS,
  PublishedDirectoryCleanupError,
  publishOwnedDirectory,
} from "@bunaway/packaging";
import { outputPaths } from "@bunaway/packaging/paths";
import { readAppVersions } from "./app-versions.ts";
import {
  type Project,
  readProjectMetadata,
  runtimeSettings,
  validateProject,
} from "./config.ts";
import {
  files,
  frameworkRoot,
  hash,
  json,
  projectPath,
  verifyHash,
  writeJson,
} from "./files.ts";
import { assertNotFrontendBuild, buildFrontend } from "./frontend-build.ts";
import { compileMacosApp } from "./macos-compile.ts";
import { runManagedCommand } from "./managed-command.ts";
import { run, runWorker } from "./processes.ts";
import { compileWindowsApp } from "./windows-compile.ts";

/** `CFBundleShortVersionString` for apps whose package.json declares no version. */
const DEFAULT_BUNDLE_VERSION = "0.0.0";

/** Native build targets supported by this CLI. */
export type Target = "windows-x64" | "macos-arm64";

/** Host, runtime, optional loader and license paths consumed by a native build. */
export interface NativeInputs {
  target: Target;
  host: string;
  bun: string;
  licenses: Record<string, string>;
  loader?: string;
}
interface Pin {
  bun: {
    version: string;
    target: string;
    executableSha256: string;
    licenseSha256: string;
  };
  json?: {
    licenseSha256: string;
  };
}
/** Output paths and launch arguments returned after a successful app build. */
export interface BuiltPackage {
  output: string;
  package: string;
  executable: string;
  arguments: string[];
}

/** Return the supported native target for this process or reject the platform. */
export function currentTarget(): Target {
  if (process.platform === "win32" && process.arch === "x64") {
    return "windows-x64";
  }
  if (process.platform === "darwin" && process.arch === "arm64") {
    return "macos-arm64";
  }
  throw new Error(
    "MVP builds require Windows x64 or macOS arm64 (native builds only).",
  );
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

/** Reject builds when the running Bun differs from the target's pinned runtime. */
export async function assertBuildBun(
  target: Target,
  root = frameworkRoot,
): Promise<void> {
  if (Bun.version !== (await readPin(target, root)).bun.version) {
    throw new Error(
      "Development/build Bun must match the pinned version (1.4.2).",
    );
  }
}

/** Prepare the host, Bun runtime and license inputs required for a local build. */
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
  // Native inputs require a matching host; use managed process ownership when a build signal is provided.
  if (target !== currentTarget()) {
    throw new Error("Cross compilation is not supported in the MVP.");
  }
  await assertBuildBun(target, root);
  const windows = target === "windows-x64";
  if (windows) {
    const args = [
      process.execPath,
      "--no-env-file",
      resolve(root, "packages/cli/src/native-build.ts"),
      "--target",
      target,
    ];
    if (signal) {
      await runManagedCommand(
        args,
        root,
        {
          BUN: process.execPath,
        },
        signal,
        root,
      );
    } else {
      await run(args, root, {
        BUN: process.execPath,
      });
    }
  }
  const pin = await readPin(target, root);
  const vendor = resolve(root, "build/cache/bun");
  const licenses: Record<string, string> = {
    "FRAMEWORK-LICENSE.txt": resolve(root, "FRAMEWORK-LICENSE.txt"),
    "THIRD-PARTY-NOTICES.txt": resolve(root, "THIRD-PARTY-NOTICES.txt"),
    "LICENSE.bun": resolve(
      windows ? vendor : resolve(root, "licenses"),
      "LICENSE.bun",
    ),
  };
  if (windows) {
    licenses["License-WebView2.txt"] = resolve(
      root,
      "build/cache/webview2/sdk/LICENSE.txt",
    );
  }
  return {
    target,
    host: resolve(
      root,
      windows ? "native/windows/bun/boot.ts" : "native/macos/bun/boot.ts",
    ),
    ...(windows
      ? {
          loader: resolve(
            root,
            "build/cache/webview2/sdk/build/native/x64/WebView2Loader.dll",
          ),
        }
      : {}),
    bun: windows
      ? resolve(vendor, `bun-${pin.bun.target}/bun.exe`)
      : process.execPath,
    licenses,
  };
}

/** Bundle project code and assets for the selected host and return compile asset names. */
export async function bundleAssets(
  project: Project,
  assets: string,
  windows = false,
  developmentServer = false,
  development = false,
): Promise<string[]> {
  const result = await runWorker(
    "assets.ts",
    windows ? "bundleWindowsAssets" : "bundleMacosAssets",
    [
      project,
      assets,
      developmentServer,
      development,
    ],
    project.root,
    project.frameworkRoot,
  );
  return JSON.parse(result) as string[];
}

/**
 * Command-line arguments the built host is launched with. A compiled Windows host
 * embeds its configuration and takes none; the Windows development host runs boot.js
 * through Bun with DevTools; macOS hosts receive the package directory.
 */
function hostArguments(
  windows: boolean,
  development: boolean,
  output: string,
  devUrl: string | undefined,
): string[] {
  const devUrlArguments =
    devUrl === undefined
      ? []
      : [
          "--dev-url",
          devUrl,
        ];
  if (!windows) {
    return [
      "--package",
      resolve(output, "Contents/Resources"),
      ...devUrlArguments,
    ];
  }
  if (!development) {
    return [];
  }
  return [
    "--no-env-file",
    "--no-install",
    `--config=${resolve(output, "assets/bunfig.toml")}`,
    `--tsconfig-override=${resolve(output, "assets/tsconfig.json")}`,
    resolve(output, "assets/boot.js"),
    "--devtools",
    ...devUrlArguments,
  ];
}

function xml(text: string): string {
  return text.replace(
    /[<>&"']/g,
    (character) =>
      ({
        "<": "&lt;",
        ">": "&gt;",
        "&": "&amp;",
        '"': "&quot;",
        "'": "&apos;",
      })[character] ?? character,
  );
}

/** Build a development or distributable app and return its launch paths and arguments. */
export async function buildProject(
  directory: string,
  options: {
    development?: boolean;
    native?: NativeInputs;
  } = {},
): Promise<BuiltPackage> {
  if (options.development) {
    const project = await validateProject(directory, {
      development: true,
    });
    return assembleProject(project, options);
  }
  // Production builds generate the frontend while holding the same lock used by packagers.
  const settings = await readProjectMetadata(directory);
  assertNotFrontendBuild(settings.root);
  const target = options.native?.target ?? currentTarget();
  await assertBuildBun(target, settings.frameworkRoot);
  // The lock covers frontend generation, asset validation and publication so
  // another build cannot change the web output while this build consumes it.
  const abort = new AbortController();
  const interrupted = () =>
    abort.abort(new Error("App build cancelled (SIGINT)."));
  const terminated = () =>
    abort.abort(new Error("App build cancelled (SIGTERM)."));
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

type BuildOptions = {
  development?: boolean;
  native?: NativeInputs;
};

/** Everything one build shares between its staging, compile, manifest and publication steps. */
interface BuildContext {
  project: Project;
  development: boolean;
  windows: boolean;
  target: Target;
  native: NativeInputs;
  server: Project["dev"];
  root: string;
  signal: AbortSignal | undefined;
  output: string;
  staging: string;
  packageRoot: string;
  assets: string;
  executable: string;
  executableName: string;
}

/** A channel artifact moved from the previous build into staging. */
interface PreservedEntry {
  source: string;
  destination: string;
}

async function webview2SdkFiles(root: string): Promise<Record<string, string>> {
  const deps = (await json(resolve(root, "native/windows/bun/deps.json"))) as {
    webview2Sdk: {
      files: Record<string, string>;
    };
  };
  return deps.webview2Sdk.files;
}

/** Check the Bun runtime and license hashes against the target's release pin. */
async function verifyNativeInputs(
  target: Target,
  root: string,
  native: NativeInputs,
  windows: boolean,
): Promise<Pin> {
  const pin = await readPin(target, root);
  await verifyHash(native.bun, pin.bun.executableSha256);
  await verifyHash(native.licenses["LICENSE.bun"] ?? "", pin.bun.licenseSha256);
  if (windows) {
    await verifyHash(
      native.licenses["License-WebView2.txt"] ?? "",
      (await webview2SdkFiles(root))["LICENSE.txt"] ?? "",
    );
  }
  return pin;
}

/** Resolve and claim the output and work directories, returning the staging layout. */
async function claimBuildLayout(
  project: Project,
  target: Target,
  development: boolean,
  windows: boolean,
) {
  const paths = outputPaths(project.root, target);
  const targetOutput = development ? paths.development : paths.output;
  const parent = dirname(targetOutput);
  await ownedDirectory(project.root, parent, true);
  const output = resolve(
    parent,
    `${basename(targetOutput)}${windows ? "" : `/${project.app.appId}.app`}`,
  );
  await ownedDirectory(project.root, dirname(output), true);
  await ownedDirectory(project.root, paths.work, true);
  const staging = resolve(
    paths.work,
    `${basename(output)}.building-${crypto.randomUUID()}`,
  );
  const packageRoot = windows
    ? staging
    : resolve(staging, "Contents/Resources");
  return {
    output,
    staging,
    packageRoot,
    assets: resolve(packageRoot, "assets"),
    executable: windows
      ? resolve(staging, "runtime/bun.exe")
      : resolve(staging, "Contents/MacOS/bunaway-host"),
    executableName: project.app.executableName ?? `${project.app.appId}.exe`,
  };
}

/** Create the staging directories and copy the runtime, licenses and app settings into them. */
async function stageRuntimeFiles({
  project,
  development,
  windows,
  native,
  server,
  packageRoot,
  assets,
  executable,
}: BuildContext): Promise<void> {
  await mkdir(resolve(assets, "web"), {
    recursive: true,
  });
  if (development && windows) {
    await mkdir(resolve(packageRoot, "runtime"), {
      recursive: true,
    });
  }
  await mkdir(resolve(packageRoot, "licenses"), {
    recursive: true,
  });
  if (!windows || development) {
    await mkdir(dirname(executable), {
      recursive: true,
    });
  }
  if (development && windows) {
    await cp(
      native.bun,
      resolve(packageRoot, `runtime/bun${windows ? ".exe" : ""}`),
    );
    await chmod(executable, 0o755);
    await chmod(
      resolve(packageRoot, `runtime/bun${windows ? ".exe" : ""}`),
      0o755,
    );
  }
  for (const [name, path] of Object.entries(native.licenses)) {
    await cp(path, resolve(packageRoot, "licenses", name));
  }
  if (!windows) {
    const settings = runtimeSettings(project, server);
    await writeJson(resolve(assets, "app.json"), settings.app);
    await writeJson(resolve(assets, "policy.json"), settings.policy);
  }
  await writeFile(resolve(assets, "bunfig.toml"), "env = false\n");
  await writeJson(resolve(assets, "tsconfig.json"), {});
}

/** Copy the pinned WebView2 loader and app icon, then compile the host unless this is a development build. */
async function compileWindowsPackage(
  {
    project,
    development,
    native,
    root,
    signal,
    packageRoot,
    assets,
    executableName,
  }: BuildContext,
  bundledAssets: string[],
): Promise<void> {
  if (!native.loader) {
    throw new Error("Windows requires the pinned WebView2Loader DLL.");
  }
  await verifyHash(
    native.loader,
    (await webview2SdkFiles(root))["build/native/x64/WebView2Loader.dll"] ?? "",
  );
  await cp(
    native.loader,
    resolve(
      packageRoot,
      development ? "assets/WebView2Loader.dll" : "WebView2Loader.dll",
    ),
  );
  if (project.app.icon) {
    await cp(
      await projectPath(project.root, project.app.icon),
      resolve(assets, "app.ico"),
    );
  }
  if (!development) {
    await compileWindowsApp(
      packageRoot,
      native.bun,
      executableName,
      project.app,
      bundledAssets,
      signal,
      root,
    );
  }
}

/** Hash the files the runtime verifies: assets and licenses, plus the loader of a compiled Windows package. */
async function hashPackageFiles({
  development,
  windows,
  packageRoot,
}: BuildContext): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  for (const dir of windows && !development
    ? [
        "licenses",
      ]
    : [
        "assets",
        "licenses",
      ]) {
    for (const file of await files(resolve(packageRoot, dir))) {
      hashes[relative(packageRoot, file).replaceAll("\\", "/")] =
        await hash(file);
    }
  }
  if (windows && !development) {
    hashes["WebView2Loader.dll"] = await hash(
      resolve(packageRoot, "WebView2Loader.dll"),
    );
  }
  return hashes;
}

/**
 * Windows development runs the Bun FFI host from boot.js; every other build ships a
 * compiled host, identified by its executable on Windows and by its source elsewhere.
 */
async function describeHost({
  development,
  windows,
  packageRoot,
  assets,
  executable,
  executableName,
}: BuildContext): Promise<Record<string, string>> {
  if (!windows) {
    return {
      kind: "bun-compiled",
      sourceSha256: await hash(executable),
    };
  }
  if (development) {
    return {
      kind: "bun-ffi",
      sha256: await hash(resolve(assets, "boot.js")),
    };
  }
  return {
    kind: "bun-compiled",
    executable: executableName,
    sha256: await hash(resolve(packageRoot, executableName)),
  };
}

/** Record release pins, hashes for selected package files and the host hash; return the app version. */
async function writePackageManifest(
  context: BuildContext,
  pin: Pin,
): Promise<string | null> {
  const { project, target, packageRoot } = context;
  const hashes = await hashPackageFiles(context);
  const versions = await readAppVersions(project.root, context.root);
  const hostManifest = await describeHost(context);
  // Absent versions are omitted so the runtime reports them as null.
  await writeJson(resolve(packageRoot, "manifest.json"), {
    ...pin,
    assets: hashes,
    app: {
      id: project.app.appId,
      ...(versions.version === null
        ? {}
        : {
            version: versions.version,
          }),
    },
    framework:
      versions.framework === null
        ? {}
        : {
            version: versions.framework,
          },
    host: {
      target,
      ...hostManifest,
    },
  });
  return versions.version;
}

/** Write the macOS bundle's Info.plist and ad-hoc sign the staged bundle. */
async function signMacosBundle(
  { project, server, root, signal, staging }: BuildContext,
  version: string | null,
): Promise<void> {
  await writeFile(
    resolve(staging, "Contents/Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>bunaway-host</string>
<key>CFBundleIdentifier</key><string>${xml(project.app.appId)}</string>
<key>CFBundleName</key><string>${xml(project.app.title)}</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${xml(version ?? DEFAULT_BUNDLE_VERSION)}</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>NSPrincipalClass</key><string>NSApplication</string>
${server ? "<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>" : ""}
</dict></plist>\n`,
  );
  const args = [
    "/usr/bin/codesign",
    "--force",
    "--sign",
    "-",
    "--entitlements",
    resolve(root, "native/macos/bun/entitlements.plist"),
    staging,
  ];
  if (signal) {
    await runManagedCommand(args, project.root, {}, signal, root);
  } else {
    await run(args, project.root);
  }
}

/** Move one channel artifact of the previous build into staging, rejecting links and wrong file kinds. */
async function preserveChannelEntry(
  project: Project,
  packaged: string,
  stagedPackaged: string,
  entry: string,
  preserved: PreservedEntry[],
): Promise<void> {
  const source = resolve(packaged, entry);
  const destination = resolve(stagedPackaged, entry);
  const info = await lstat(source);
  if (
    info.isSymbolicLink() ||
    !(entry.endsWith("-report.json") ? info.isFile() : info.isDirectory())
  ) {
    throw new Error(
      `Packaged output must be a regular file or directory: ${source}`,
    );
  }
  // Move the existing tree so Windows junctions never need to be recreated.
  await ownedDirectory(project.root, dirname(destination));
  await rename(source, destination);
  preserved.push({
    source,
    destination,
  });
}

/** Channel packages live inside the Windows build output, but survive rebuilds. */
async function preservePackagedOutput(
  { project, output, staging }: BuildContext,
  preserved: PreservedEntry[],
): Promise<void> {
  const packaged = resolve(output, "packaged");
  if (!(await ownedDirectory(project.root, packaged))) {
    return;
  }
  const stagedPackaged = resolve(staging, "packaged");
  await mkdir(stagedPackaged, {
    recursive: true,
  });
  for (const entry of await readdir(packaged)) {
    if (
      PACKAGING_CHANNELS.some(
        (channel) => entry === channel || entry === `${channel}-report.json`,
      )
    ) {
      await preserveChannelEntry(
        project,
        packaged,
        stagedPackaged,
        entry,
        preserved,
      );
    }
  }
}

/** Put moved channel artifacts back (unless already published) and discard the staging tree. */
async function discardFailedBuild(
  { project, staging }: BuildContext,
  preserved: PreservedEntry[],
  published: boolean,
  error: unknown,
): Promise<never> {
  try {
    if (!published) {
      // Restore channel artifacts moved from the prior build before discarding this staging tree.
      for (const { source, destination } of preserved.reverse()) {
        await ownedDirectory(project.root, dirname(source));
        await ownedDirectory(project.root, dirname(destination));
        await rename(destination, source);
      }
    }
    await ownedDirectory(project.root, dirname(staging));
    await rm(staging, {
      recursive: true,
      force: true,
    });
  } catch (cleanupError) {
    throw new AggregateError(
      [
        error,
        cleanupError,
      ],
      `${error instanceof Error ? error.message : String(error)}; build cleanup failed`,
      {
        cause: error,
      },
    );
  }
  throw error;
}

function builtPackage({
  development,
  windows,
  server,
  output,
  executableName,
}: BuildContext): BuiltPackage {
  return {
    output,
    package: windows ? output : resolve(output, "Contents/Resources"),
    executable: windows
      ? resolve(output, development ? "runtime/bun.exe" : executableName)
      : resolve(output, "Contents/MacOS/bunaway-host"),
    arguments: hostArguments(windows, development, output, server?.url),
  };
}

/** Assemble a package in staging and preserve the previous output if publication fails. */
async function assembleProject(
  project: Project,
  options: BuildOptions,
  signal?: AbortSignal,
): Promise<BuiltPackage> {
  signal?.throwIfAborted();
  const root = project.frameworkRoot;
  const development = options.development ?? false;
  const target = options.native?.target ?? currentTarget();
  await assertBuildBun(target, root);
  const windows = target === "windows-x64";
  const native =
    options.native ?? (await prepareNativeForBuild(target, root, signal));
  signal?.throwIfAborted();
  const pin = await verifyNativeInputs(target, root, native, windows);
  await stat(native.host);
  const context: BuildContext = {
    project,
    development,
    windows,
    target,
    native,
    server: development ? project.dev : undefined,
    root,
    signal,
    ...(await claimBuildLayout(project, target, development, windows)),
  };
  const preserved: PreservedEntry[] = [];
  let published = false;
  try {
    // Complete each package in its owned work directory before replacing the output.
    await stageRuntimeFiles(context);
    const bundledAssets = await bundleAssets(
      project,
      context.assets,
      windows,
      !!context.server,
      development,
    );
    signal?.throwIfAborted();
    // Compile only after the app metadata, policy and bundled web files are in place.
    if (windows) {
      await compileWindowsPackage(context, bundledAssets);
    } else {
      await compileMacosApp(
        context.assets,
        native.bun,
        context.executable,
        bundledAssets,
        signal,
        root,
      );
    }
    await ownedDirectory(project.root, context.staging);
    const version = await writePackageManifest(context, pin);
    if (!windows) {
      await signMacosBundle(context, version);
    }
    signal?.throwIfAborted();
    // The work tree can change while bundling or signing; check it before moving preserved output.
    await ownedDirectory(project.root, context.staging);
    await ownedDirectory(project.root, context.output);
    if (windows && !development) {
      await preservePackagedOutput(context, preserved);
    }
    signal?.throwIfAborted();
    // The publication owner preserves prior output and reports whether cleanup failed after commit.
    try {
      await publishOwnedDirectory(
        project.root,
        context.staging,
        context.output,
      );
      published = true;
    } catch (error) {
      published = error instanceof PublishedDirectoryCleanupError;
      throw error;
    }
    return builtPackage(context);
  } catch (error) {
    return discardFailedBuild(context, preserved, published, error);
  }
}
