import { cp, lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  acquireBuildOutputLock,
  ownedDirectory,
  publishOwnedDirectory,
} from "@bunaway/packaging";
import { outputPaths } from "@bunaway/packaging/paths";
import {
  API_LIMITS,
  MAX_JSON_DEPTH,
  MAX_MESSAGE_BYTES,
} from "@bunaway/protocol";
import {
  type Project,
  readProjectMetadata,
  validateProject,
} from "./config.ts";
import { frameworkRoot, hash, json, verifyHash, writeJson } from "./files.ts";
import { buildFrontend } from "./frontend-build.ts";
import { runManagedCommand } from "./managed-command.ts";
import { runWorker } from "./processes.ts";

const ANDROID_APPLICATION_ID_PATTERN =
  /^[a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z][a-zA-Z0-9_]*)+$(?![\s\S])/;

/** Reject Android configurations that this single-view, packaged-asset host cannot execute. */
export function assertAndroidProject(
  project: Pick<Project, "app" | "policy">,
): asserts project is Pick<Project, "app" | "policy"> & {
  app: Required<Pick<Project["app"], "view" | "home" | "window">>;
} {
  if (
    project.app.windows ||
    !project.app.view ||
    !project.app.home ||
    !project.app.window
  ) {
    throw new Error("Android currently requires one app.view and app.home.");
  }
  const home = new URL(project.app.home);
  if (
    home.protocol !== "https:" ||
    home.username ||
    home.password ||
    home.port
  ) {
    throw new Error(
      "Android app.home requires a packaged HTTPS origin without credentials or a port.",
    );
  }
  if (!ANDROID_APPLICATION_ID_PATTERN.test(project.app.appId)) {
    throw new Error(
      "Android app.appId requires at least two Java package segments.",
    );
  }
  if (
    project.policy.backend.permissions.length ||
    project.policy.views.some((view) => view.host.permissions.length)
  ) {
    throw new Error(
      "Android native plugins are not implemented; host permissions must be empty.",
    );
  }
}

/** Prepare shared APK inputs without invoking Gradle or requiring an installed SDK. */
async function prepareAndroidInputs(
  project: Pick<Project, "app" | "policy">,
  inputs: string,
  root = frameworkRoot,
  signal = new AbortController().signal,
): Promise<void> {
  assertAndroidProject(project);
  if (process.platform !== "win32") {
    throw new Error("Android builds currently require Windows.");
  }
  const bunVersion = await prepareAndroidRuntime(inputs, root, signal);
  const assets = resolve(inputs, "assets/bunaway");
  await mkdir(resolve(inputs, "generated"), {
    recursive: true,
  });
  await mkdir(assets, {
    recursive: true,
  });
  const title = project.app.title
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(
      /[<>&]/g,
      (character) =>
        ({
          "<": "&lt;",
          ">": "&gt;",
          "&": "&amp;",
        })[character] ?? character,
    );
  await mkdir(resolve(inputs, "generated-res/values"), {
    recursive: true,
  });
  await writeFile(
    resolve(inputs, "generated-res/values/strings.xml"),
    `<resources><string name="bunaway_app_title" formatted="false">"${title}"</string></resources>\n`,
  );
  await writeFile(
    resolve(inputs, "generated/ProtocolLimits.java"),
    `package dev.bunaway.host;\n/** Generated from @bunaway/protocol. */\nfinal class ProtocolLimits {\n    static final int MAX_MESSAGE_BYTES = ${MAX_MESSAGE_BYTES};\n    static final int MAX_JSON_DEPTH = ${MAX_JSON_DEPTH};\n    static final int MAX_PENDING = ${API_LIMITS.maxPending};\n    static final long HANDSHAKE_TIMEOUT_MS = ${API_LIMITS.handshakeTimeoutMs}L;\n    static final long SHUTDOWN_TIMEOUT_MS = ${API_LIMITS.shutdownTimeoutMs}L;\n    private ProtocolLimits() {}\n}\n`,
  );
  for (const name of [
    "process",
    "message",
    "policy",
  ]) {
    await cp(
      resolve(root, `native/host-api/generated/${name}.schema.json`),
      resolve(assets, `${name}.schema.json`),
    );
  }
  await cp(
    resolve(root, "native/android/bridge.js"),
    resolve(assets, "bridge.js"),
  );
  await writeFile(resolve(assets, "bunfig.toml"), "env = false\n");
  await writeJson(resolve(assets, "tsconfig.json"), {});
  await writeJson(resolve(assets, "host.json"), {
    appId: project.app.appId,
    title: project.app.title,
    view: project.app.view,
    home: new URL(project.app.home).href,
    policy: project.policy,
    bunVersion,
  });
}

/** Download and verify the bundled executables and retain their license texts in APK inputs. */
async function prepareAndroidRuntime(
  inputs: string,
  root: string,
  signal: AbortSignal,
): Promise<string> {
  const assets = resolve(inputs, "assets/bunaway");
  const pins = await Promise.all(
    [
      "x64",
      "arm64",
    ].map(async (target) => {
      // These immutable framework manifests were validated with the installed release.
      const pin = (await json(
        resolve(root, `runtime/build-manifests/android-${target}.json`),
      )) as {
        bun: {
          version: string;
          target: string;
          executableSha256: string;
        };
      };
      return pin.bun;
    }),
  );
  const bunVersion = pins[0]?.version;
  if (
    !bunVersion ||
    Bun.version !== bunVersion ||
    pins.some((pin) => pin.version !== bunVersion)
  ) {
    throw new Error(
      `Android build Bun must match both pinned runtimes (${bunVersion ?? "missing version"}).`,
    );
  }
  await runManagedCommand(
    [
      process.execPath,
      "--no-env-file",
      resolve(root, "packages/cli/src/native-build.ts"),
      "--target",
      "android",
    ],
    root,
    {},
    signal,
    root,
  );
  for (const [index, target, abi] of [
    [
      0,
      "x64",
      "x86_64",
    ],
    [
      1,
      "arm64",
      "arm64-v8a",
    ],
  ] as const) {
    const pin = pins[index];
    if (!pin) {
      throw new Error("Missing Android runtime pin.");
    }
    const runtime = resolve(
      root,
      `build/cache/android-bun/${target}/bun-${pin.target}/bun`,
    );
    await verifyHash(runtime, pin.executableSha256);
    await mkdir(resolve(inputs, "jniLibs", abi), {
      recursive: true,
    });
    await cp(runtime, resolve(inputs, "jniLibs", abi, "libbun.so"));
  }
  await mkdir(resolve(assets, "licenses"), {
    recursive: true,
  });
  await cp(
    resolve(root, "build/cache/android-bun/x64/LICENSE.bun"),
    resolve(assets, "licenses/LICENSE.bun"),
  );
  for (const name of [
    "FRAMEWORK-LICENSE.txt",
    "THIRD-PARTY-NOTICES.txt",
  ]) {
    await cp(resolve(root, name), resolve(assets, "licenses", name));
  }
  await cp(
    resolve(root, "licenses/LICENSE.apache-2.0.txt"),
    resolve(assets, "licenses/LICENSE.apache-2.0.txt"),
  );
  return bunVersion;
}

/** Copy only framework sources; Gradle output and caches stay outside the managed sync tree. */
async function copyAndroidHost(root: string, managed: string): Promise<void> {
  const host = resolve(managed, "host");
  await mkdir(host, {
    recursive: true,
  });
  await cp(resolve(root, "native/android/host/src"), resolve(host, "src"), {
    recursive: true,
  });
  await cp(
    resolve(root, "native/android/host/build.gradle"),
    resolve(host, "build.gradle"),
  );
  await cp(
    resolve(root, "native/android/app.gradle"),
    resolve(managed, "app.gradle"),
  );
  await cp(
    resolve(root, "native/android/host-settings.gradle"),
    resolve(managed, "settings.gradle"),
  );
}

/** Create the editable Java app and Gradle wrapper only when a project is first added. */
async function copyAndroidProject(
  root: string,
  destination: string,
): Promise<void> {
  await mkdir(destination, {
    recursive: true,
  });
  for (const name of [
    "app",
    "gradle",
    "gradlew",
    "gradlew.bat",
    "build.gradle",
    "settings.gradle",
    "gradle.properties",
  ]) {
    await cp(
      resolve(root, "native/android", name),
      resolve(destination, name),
      {
        recursive: true,
      },
    );
  }
  await cp(
    resolve(root, "native/android/gitignore"),
    resolve(destination, ".gitignore"),
  );
  await writeJson(resolve(destination, "bunaway-project.json"), {
    format: 1,
  });
}

/** Reject existing unrelated projects and linked marker files before touching their contents. */
async function androidProjectExists(root: string): Promise<boolean> {
  const directory = resolve(root, "android");
  if (!(await ownedDirectory(root, directory))) {
    return false;
  }
  const marker = resolve(directory, "bunaway-project.json");
  const entry = await lstat(marker).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") {
      throw error;
    }
    return undefined;
  });
  if (!entry?.isFile() || entry.isSymbolicLink()) {
    throw new Error(
      "Existing android directory is not a bunaway project; refusing to overwrite it.",
    );
  }
  const value = await json(marker);
  if (
    typeof value !== "object" ||
    value === null ||
    !("format" in value) ||
    value.format !== 1
  ) {
    throw new Error("Unsupported Android project format.");
  }
  await ownedDirectory(root, resolve(directory, ".bunaway"));
  return true;
}

/** Publish generated assets and host code while preserving every app-owned native source and build setting. */
export async function publishAndroidProject(
  root: string,
  prepared: string,
  framework = frameworkRoot,
): Promise<string> {
  const directory = resolve(root, "android");
  if (await androidProjectExists(root)) {
    await publishOwnedDirectory(root, prepared, resolve(directory, ".bunaway"));
  } else {
    const scaffold = resolve(dirname(prepared), "project");
    await copyAndroidProject(framework, scaffold);
    await rename(prepared, resolve(scaffold, ".bunaway"));
    await publishOwnedDirectory(root, scaffold, directory);
  }
  return directory;
}

async function buildAndroidApk(
  directory: string,
  output: string,
  signal: AbortSignal,
  root: string,
): Promise<string> {
  if (!process.env.ANDROID_HOME || !process.env.JAVA_HOME) {
    throw new Error(
      "Set ANDROID_HOME and JAVA_HOME to the Android SDK and JDK 17 or later.",
    );
  }
  await runManagedCommand(
    [
      resolve(directory, "gradlew.bat"),
      "--no-daemon",
      "--project-cache-dir",
      resolve(directory, ".gradle"),
      "-p",
      directory,
      `-PbunawayBuildDirectory=${output}`,
      ":app:assembleDebug",
      ":app:lintDebug",
      ":host:lintDebug",
      ":host:testDebugUnitTest",
    ],
    directory,
    {},
    signal,
    root,
  );
  return resolve(output, "outputs/apk/debug/app-debug.apk");
}

/** Read Gradle's final APK identity, including applicationId overrides and debug suffixes. */
export async function readAndroidApplicationId(
  output: string,
): Promise<string> {
  const metadata = await json(
    resolve(output, "outputs/apk/debug/output-metadata.json"),
  );
  if (
    typeof metadata !== "object" ||
    metadata === null ||
    !("applicationId" in metadata) ||
    typeof metadata.applicationId !== "string" ||
    !ANDROID_APPLICATION_ID_PATTERN.test(metadata.applicationId)
  ) {
    throw new Error(
      "Invalid Android APK application ID in Gradle output metadata.",
    );
  }
  return metadata.applicationId;
}

/** Assemble the native execution fixture using the same Java modules and inputs as app sync. */
export async function assembleAndroidApk(
  project: Pick<Project, "app" | "policy">,
  inputs: string,
  root = frameworkRoot,
  signal = new AbortController().signal,
): Promise<string> {
  const directory = resolve(inputs, "project");
  await ownedDirectory(inputs, directory, true);
  await copyAndroidProject(root, directory);
  const managed = resolve(directory, ".bunaway");
  await copyAndroidHost(root, managed);
  await prepareAndroidInputs(project, inputs, root, signal);
  for (const name of [
    "assets",
    "generated",
    "jniLibs",
    "generated-res",
  ]) {
    await cp(resolve(inputs, name), resolve(managed, "inputs", name), {
      recursive: true,
    });
  }
  return await buildAndroidApk(
    directory,
    resolve(inputs, "gradle-output"),
    signal,
    root,
  );
}

/**
 * Syncs the native project and optionally builds and launches a debug APK under one target lock.
 * Requires Windows, pinned Bun and SDK/JDK paths. Rejects unsupported settings or
 * tool failures, preserves prior output until publication and releases the lock.
 */
async function prepareAndroidProject(
  directory: string,
  build: boolean,
  serial?: string,
): Promise<{
  project: string;
  apk: string;
  appId: string;
}> {
  const metadata = await readProjectMetadata(directory);
  assertAndroidProject(metadata);
  await androidProjectExists(metadata.root);
  const paths = outputPaths(metadata.root, "android");
  const abort = new AbortController();
  const interrupted = () => abort.abort(new Error("Android build cancelled."));
  process.on("SIGINT", interrupted);
  process.on("SIGTERM", interrupted);
  let release: (() => Promise<void>) | undefined;
  const staging = resolve(paths.work, crypto.randomUUID());
  try {
    release = await acquireBuildOutputLock(metadata.root, "android");
    await ownedDirectory(metadata.root, staging, true);
    await buildFrontend(metadata, abort.signal);
    const project = await validateProject(metadata.root);
    assertAndroidProject(project);
    const managed = resolve(staging, "managed");
    const inputs = resolve(managed, "inputs");
    const assets = resolve(inputs, "assets/bunaway");
    await mkdir(assets, {
      recursive: true,
    });
    await runWorker(
      "assets.ts",
      "bundleAndroidAssets",
      [
        project,
        assets,
      ],
      project.root,
      project.frameworkRoot,
    );
    abort.signal.throwIfAborted();
    await copyAndroidHost(project.frameworkRoot, managed);
    await prepareAndroidInputs(
      project,
      inputs,
      project.frameworkRoot,
      abort.signal,
    );
    abort.signal.throwIfAborted();
    const android = await publishAndroidProject(
      project.root,
      managed,
      project.frameworkRoot,
    );
    const apk = resolve(paths.output, "app-debug.apk");
    if (!build) {
      return {
        project: android,
        apk,
        appId: project.app.appId,
      };
    }
    const gradleOutput = resolve(staging, "gradle-output");
    const built = await buildAndroidApk(
      android,
      gradleOutput,
      abort.signal,
      project.frameworkRoot,
    );
    const appId = await readAndroidApplicationId(gradleOutput);
    const stagedOutput = resolve(staging, "output");
    await mkdir(stagedOutput);
    await cp(built, resolve(stagedOutput, "app-debug.apk"));
    await writeJson(resolve(stagedOutput, "manifest.json"), {
      format: 1,
      appId,
      kind: "android-debug",
      sha256: await hash(built),
    });
    abort.signal.throwIfAborted();
    await publishOwnedDirectory(project.root, stagedOutput, paths.output);
    if (serial !== undefined) {
      await installAndroidApk(project.root, apk, appId, serial, abort.signal);
    }
    return {
      project: android,
      apk,
      appId,
    };
  } finally {
    try {
      await ownedDirectory(metadata.root, staging);
      await rm(staging, {
        recursive: true,
        force: true,
      });
    } finally {
      try {
        await release?.();
      } finally {
        process.off("SIGINT", interrupted);
        process.off("SIGTERM", interrupted);
      }
    }
  }
}

/**
 * Build web and Bun assets and refresh an Android Studio project at <app>/android.
 * Creates the editable Java app once, then replaces only android/.bunaway. Requires
 * Windows and pinned Bun, downloads pinned runtimes, rejects unrelated or linked
 * directories, preserves previous generated inputs on failure and releases its lock.
 */
export async function syncAndroidProject(directory: string): Promise<string> {
  return (await prepareAndroidProject(directory, false)).project;
}

/**
 * Sync and build a debug APK using the app-owned native project. Requires SDK/JDK
 * paths, retains the previous APK on failure and returns its absolute path and final Gradle app ID.
 */
export async function buildAndroidProject(directory: string): Promise<{
  apk: string;
  appId: string;
}> {
  const { apk, appId } = await prepareAndroidProject(directory, true);
  return {
    apk,
    appId,
  };
}

/** Validate the ADB device argument before accessing the project or launching tools. */
export function isAndroidSerial(serial: string): boolean {
  return /^[A-Za-z0-9_.:-]+$(?![\s\S])/.test(serial);
}

/**
 * Builds, installs and starts a debug APK on the explicitly selected device.
 * Rejects invalid serials and build/ADB failures. Holds the target lock through launch,
 * supports cancellation and returns after launch; Android owns the app.
 */
export async function runAndroidProject(
  directory: string,
  serial: string,
): Promise<void> {
  if (!isAndroidSerial(serial)) {
    throw new Error("Invalid Android device serial.");
  }
  await prepareAndroidProject(directory, true, serial);
}

/** Install and launch the published APK while its caller still owns the output lock. */
async function installAndroidApk(
  directory: string,
  apk: string,
  appId: string,
  serial: string,
  signal: AbortSignal,
): Promise<void> {
  const sdk = process.env.ANDROID_HOME;
  if (!sdk) {
    throw new Error("Set ANDROID_HOME.");
  }
  const adb = resolve(sdk, "platform-tools/adb.exe");
  console.log(
    await androidCommand(
      [
        adb,
        "-s",
        serial,
        "install",
        "-r",
        apk,
      ],
      directory,
      signal,
    ),
  );
  await androidCommand(
    [
      adb,
      "-s",
      serial,
      "shell",
      "am",
      "force-stop",
      appId,
    ],
    directory,
    signal,
  );
  await launchAndroidActivity(
    [
      adb,
      "-s",
      serial,
    ],
    directory,
    appId,
    signal,
  );
}

/** Await one ADB client and its output before releasing owned resources, including on cancellation. */
async function androidCommand(
  args: readonly string[],
  directory: string,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const child = Bun.spawn(
    [
      ...args,
    ],
    {
      cwd: directory,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      ...(signal
        ? {
            signal,
          }
        : {}),
    },
  );
  const [text, errors, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  signal?.throwIfAborted();
  if (code !== 0 || /(?:^|\n)Error:/i.test(`${text}\n${errors}`)) {
    throw new Error(
      `Android command failed: ${errors || text || `exit ${code}`}`,
    );
  }
  return text.trim();
}

/** Resolve the app-owned launcher before starting it; ADB may report launch errors with exit code zero. */
export async function launchAndroidActivity(
  adb: readonly string[],
  directory: string,
  appId: string,
  signal?: AbortSignal,
): Promise<void> {
  async function output(args: string[]): Promise<string> {
    return androidCommand(
      [
        ...adb,
        "shell",
        ...args,
      ],
      directory,
      signal,
    );
  }
  const resolved = await output([
    "cmd",
    "package",
    "resolve-activity",
    "--brief",
    "-a",
    "android.intent.action.MAIN",
    "-c",
    "android.intent.category.LAUNCHER",
    appId,
  ]);
  const component = resolved.split(/\r?\n/).at(-1);
  if (
    !component?.startsWith(`${appId}/`) ||
    !/^[A-Za-z0-9_.$]+\/[A-Za-z0-9_.$]+$/.test(component)
  ) {
    throw new Error("Android app has no resolvable launcher activity.");
  }
  console.log(
    await output([
      "am",
      "start",
      "-W",
      "-n",
      component,
    ]),
  );
}
