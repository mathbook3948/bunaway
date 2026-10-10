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
  publishOwnedDirectory,
  PublishedDirectoryCleanupError,
} from "@bunaway/packaging";
import { outputPaths } from "@bunaway/packaging/paths";
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

/** Assemble a package in staging and preserve the previous output if publication fails. */
async function assembleProject(
  project: Project,
  options: {
    development?: boolean;
    native?: NativeInputs;
  },
  signal?: AbortSignal,
): Promise<BuiltPackage> {
  signal?.throwIfAborted();
  const root = project.frameworkRoot;
  const server = options.development ? project.dev : undefined;
  const target = options.native?.target ?? currentTarget();
  await assertBuildBun(target, root);
  const windows = target === "windows-x64";
  const native =
    options.native ?? (await prepareNativeForBuild(target, root, signal));
  signal?.throwIfAborted();
  const pin = await readPin(target, root);
  await verifyHash(native.bun, pin.bun.executableSha256);
  await verifyHash(native.licenses["LICENSE.bun"] ?? "", pin.bun.licenseSha256);
  if (windows) {
    const deps = (await json(
      resolve(root, "native/windows/bun/deps.json"),
    )) as {
      webview2Sdk: {
        files: Record<string, string>;
      };
    };
    await verifyHash(
      native.licenses["License-WebView2.txt"] ?? "",
      deps.webview2Sdk.files["LICENSE.txt"] ?? "",
    );
  }
  await stat(native.host);
  const paths = outputPaths(project.root, target);
  const targetOutput = options.development ? paths.development : paths.output;
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
  const executable = windows
    ? resolve(staging, "runtime/bun.exe")
    : resolve(staging, "Contents/MacOS/bunaway-host");
  const executableName =
    project.app.executableName ?? `${project.app.appId}.exe`;
  const preserved: {
    source: string;
    destination: string;
  }[] = [];
  let published = false;
  try {
    // Complete each package in its owned work directory before replacing the output.
    const assets = resolve(packageRoot, "assets");
    await mkdir(resolve(assets, "web"), {
      recursive: true,
    });
    if (options.development && windows) {
      await mkdir(resolve(packageRoot, "runtime"), {
        recursive: true,
      });
    }
    await mkdir(resolve(packageRoot, "licenses"), {
      recursive: true,
    });
    if (!windows || options.development) {
      await mkdir(dirname(executable), {
        recursive: true,
      });
    }
    if (options.development && windows) {
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
    const bundledAssets = await bundleAssets(
      project,
      assets,
      windows,
      !!server,
      options.development ?? false,
    );
    signal?.throwIfAborted();
    // Compile only after the app metadata, policy and bundled web files are in place.
    if (windows) {
      if (!native.loader) {
        throw new Error("Windows requires the pinned WebView2Loader DLL.");
      }
      const deps = (await json(
        resolve(root, "native/windows/bun/deps.json"),
      )) as {
        webview2Sdk: {
          files: Record<string, string>;
        };
      };
      await verifyHash(
        native.loader,
        deps.webview2Sdk.files["build/native/x64/WebView2Loader.dll"] ?? "",
      );
      await cp(
        native.loader,
        resolve(
          packageRoot,
          options.development
            ? "assets/WebView2Loader.dll"
            : "WebView2Loader.dll",
        ),
      );
      if (project.app.icon) {
        await cp(
          await projectPath(project.root, project.app.icon),
          resolve(assets, "app.ico"),
        );
      }
      if (!options.development) {
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
    if (!windows) {
      await compileMacosApp(
        assets,
        native.bun,
        executable,
        bundledAssets,
        signal,
        root,
      );
    }
    await ownedDirectory(project.root, staging);
    const hashes: Record<string, string> = {};
    for (const dir of windows && !options.development
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
    if (windows && !options.development) {
      hashes["WebView2Loader.dll"] = await hash(
        resolve(packageRoot, "WebView2Loader.dll"),
      );
    }
    // Record release pins, hashes for selected package files, and the host hash.
    const framework = (await json(resolve(root, "package.json"))) as {
      version: string;
    };
    const appPackage = (await json(resolve(project.root, "package.json"))) as {
      version: string;
    };
    await writeJson(resolve(packageRoot, "manifest.json"), {
      ...pin,
      ...(!windows
        ? {
            json: undefined,
          }
        : {}),
      assets: hashes,
      app: {
        id: project.app.appId,
        version: appPackage.version,
      },
      framework: {
        version: framework.version,
      },
      host: {
        target,
        ...(windows
          ? options.development
            ? {
                kind: "bun-ffi",
                sha256: await hash(resolve(assets, "boot.js")),
              }
            : {
                kind: "bun-compiled",
                executable: executableName,
                sha256: await hash(resolve(packageRoot, executableName)),
              }
          : {
              kind: "bun-compiled",
              sourceSha256: await hash(executable),
            }),
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
    signal?.throwIfAborted();
    // The work tree can change while bundling or signing; check it before moving preserved output.
    await ownedDirectory(project.root, staging);
    await ownedDirectory(project.root, output);
    if (windows && !options.development) {
      // Channel packages live inside the Windows build output, but survive rebuilds.
      const packaged = resolve(output, "packaged");
      const previous = await ownedDirectory(project.root, packaged);
      if (previous) {
        await mkdir(resolve(staging, "packaged"), {
          recursive: true,
        });
        for (const entry of await readdir(packaged)) {
          if (
            PACKAGING_CHANNELS.some(
              (channel) =>
                entry === channel || entry === `${channel}-report.json`,
            )
          ) {
            const source = resolve(packaged, entry);
            const destination = resolve(staging, "packaged", entry);
            const info = await lstat(source);
            if (
              info.isSymbolicLink() ||
              !(entry.endsWith("-report.json")
                ? info.isFile()
                : info.isDirectory())
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
        }
      }
    }
    signal?.throwIfAborted();
    // The publication owner preserves prior output and reports whether cleanup failed after commit.
    try {
      await publishOwnedDirectory(project.root, staging, output);
      published = true;
    } catch (error) {
      published = error instanceof PublishedDirectoryCleanupError;
      throw error;
    }
    return {
      output,
      package: windows ? output : resolve(output, "Contents/Resources"),
      executable: windows
        ? resolve(
            output,
            options.development ? "runtime/bun.exe" : executableName,
          )
        : resolve(output, "Contents/MacOS/bunaway-host"),
      arguments:
        windows && !options.development
          ? []
          : windows
            ? [
                "--no-env-file",
                "--no-install",
                `--config=${resolve(output, "assets/bunfig.toml")}`,
                `--tsconfig-override=${resolve(output, "assets/tsconfig.json")}`,
                resolve(output, "assets/boot.js"),
                ...(options.development
                  ? [
                      "--devtools",
                    ]
                  : []),
                ...(server
                  ? [
                      "--dev-url",
                      server.url,
                    ]
                  : []),
              ]
            : [
                "--package",
                resolve(output, "Contents/Resources"),
                ...(server
                  ? [
                      "--dev-url",
                      server.url,
                    ]
                  : []),
              ],
    };
  } catch (error) {
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
}
