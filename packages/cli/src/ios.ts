import { cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { ownedDirectory, publishOwnedDirectory } from "@bunaway/packaging";
import { outputPaths } from "@bunaway/packaging/paths";
import {
  API_LIMITS,
  MAX_JSON_DEPTH,
  MAX_MESSAGE_BYTES,
  messageSchema,
  PROCESS_IPC_VERSION,
  PROTOCOL_VERSION,
} from "@bunaway/protocol";
import {
  type Project,
  readProjectMetadata,
  validateProject,
} from "./config.ts";
import { frameworkRoot, hash, json, verifyHash, writeJson } from "./files.ts";
import { buildFrontend } from "./frontend-build.ts";
import { runManagedCommand } from "./managed-command.ts";
import {
  mobileBridge,
  mobileProjectExists,
  withMobileBuild,
} from "./mobile-project.ts";
import { fetchDependency } from "./native-build.ts";
import { runWorker } from "./processes.ts";

const IOS_BUNDLE_ID_PATTERN = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$(?![\s\S])/;

/** Reject settings the single packaged iOS view and initial native host cannot provide. */
export function assertIosProject(
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
    throw new Error("iOS currently requires one app.view and app.home.");
  }
  const home = new URL(project.app.home);
  if (
    home.protocol !== "https:" ||
    home.username ||
    home.password ||
    home.port
  ) {
    throw new Error(
      "iOS app.home requires a packaged HTTPS origin without credentials or a port.",
    );
  }
  if (!IOS_BUNDLE_ID_PATTERN.test(project.app.appId)) {
    throw new Error(
      "iOS app.appId requires a valid reverse-domain bundle identifier.",
    );
  }
  if (
    project.policy.backend.permissions.length ||
    project.policy.views.some((view) => view.host.permissions.length)
  ) {
    throw new Error(
      "iOS native plugins are not implemented; host permissions must be empty.",
    );
  }
}

/** Atomically refresh framework inputs, creating the editable Xcode project only once. */
export async function publishIosProject(
  root: string,
  prepared: string,
  framework = frameworkRoot,
): Promise<string> {
  const directory = resolve(root, "ios");
  if (await mobileProjectExists(root, "ios")) {
    await publishOwnedDirectory(root, prepared, resolve(directory, ".bunaway"));
  } else {
    const scaffold = resolve(dirname(prepared), "project");
    await mkdir(resolve(scaffold, "Bunaway.xcodeproj"), {
      recursive: true,
    });
    await cp(
      resolve(framework, "native/ios/project.pbxproj"),
      resolve(scaffold, "Bunaway.xcodeproj/project.pbxproj"),
    );
    await cp(
      resolve(framework, "native/ios/app/AppDelegate.swift"),
      resolve(scaffold, "AppDelegate.swift"),
    );
    await writeJson(resolve(scaffold, "bunaway-project.json"), {
      format: 1,
    });
    await writeFile(
      resolve(scaffold, ".gitignore"),
      ".bunaway/\nxcuserdata/\n*.xcuserstate\n",
    );
    await rename(prepared, resolve(scaffold, ".bunaway"));
    await publishOwnedDirectory(root, scaffold, directory);
  }
  return directory;
}

/** Resolves and validates the pin from the same installed framework that supplies host inputs. */
async function readIosRuntimePin(framework: string) {
  const manifest = await json(
    resolve(framework, "runtime/build-manifests/ios-arm64.json"),
  );
  if (
    !manifest ||
    typeof manifest !== "object" ||
    !("bun" in manifest) ||
    !manifest.bun ||
    typeof manifest.bun !== "object"
  ) {
    throw new Error("Invalid iOS runtime manifest.");
  }
  const bun = manifest.bun;
  if (
    !("version" in bun) ||
    typeof bun.version !== "string" ||
    !bun.version ||
    !("release" in bun) ||
    typeof bun.release !== "string" ||
    !bun.release ||
    !("archiveUrl" in bun) ||
    typeof bun.archiveUrl !== "string" ||
    new URL(bun.archiveUrl).protocol !== "https:" ||
    !("archiveSha256" in bun) ||
    typeof bun.archiveSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(bun.archiveSha256) ||
    !("deviceSha256" in bun) ||
    typeof bun.deviceSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(bun.deviceSha256) ||
    !("simulatorSha256" in bun) ||
    typeof bun.simulatorSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(bun.simulatorSha256)
  ) {
    throw new Error("Invalid iOS runtime pin.");
  }
  return {
    version: bun.version,
    release: bun.release,
    archiveUrl: bun.archiveUrl,
    archiveSha256: bun.archiveSha256,
    deviceSha256: bun.deviceSha256,
    simulatorSha256: bun.simulatorSha256,
  };
}

/** Download the pinned XCFramework and verify both native slices before Xcode can sign them. */
async function prepareIosRuntime(
  managed: string,
  framework: string,
  signal: AbortSignal,
): Promise<string> {
  const pin = await readIosRuntimePin(framework);
  if (Bun.version !== pin.version) {
    throw new Error(`iOS build Bun must match ${pin.version}.`);
  }
  const cache = resolve(framework, "build/cache/ios-bun");
  await ownedDirectory(framework, cache, true);
  const archive = resolve(cache, "bun-ios-aarch64.zip");
  await fetchDependency(
    pin.archiveUrl,
    archive,
    pin.archiveSha256,
    false,
    signal,
  );
  signal.throwIfAborted();
  const extracted = resolve(managed, "extracted");
  await mkdir(extracted);
  await runManagedCommand(
    [
      "/usr/bin/unzip",
      "-q",
      archive,
      "-d",
      extracted,
    ],
    framework,
    {},
    signal,
    framework,
  );
  const source = resolve(extracted, "bun-ios-aarch64");
  await verifyHash(
    resolve(source, "Bun.xcframework/ios-arm64/libBun.dylib"),
    pin.deviceSha256,
  );
  await verifyHash(
    resolve(source, "Bun.xcframework/ios-arm64-simulator/libBun.dylib"),
    pin.simulatorSha256,
  );
  // Xcode copies packaged assets, not the runtime directory's license files.
  const licenses = resolve(managed, "assets/bunaway-assets/licenses");
  await mkdir(licenses, {
    recursive: true,
  });
  for (const name of [
    "LICENSE.md",
    "LICENSE-libffi",
  ]) {
    await cp(resolve(source, name), resolve(licenses, name));
  }
  for (const name of [
    "FRAMEWORK-LICENSE.txt",
    "THIRD-PARTY-NOTICES.txt",
  ]) {
    await cp(resolve(framework, name), resolve(licenses, name));
  }
  await rename(source, resolve(managed, "runtime"));
  await cp(
    resolve(managed, "runtime/Bun.xcframework/ios-arm64/Headers/embedding.h"),
    resolve(managed, "host/embedding.h"),
  );
  await rm(extracted, {
    recursive: true,
  });
  return pin.release;
}

function plistText(value: string): string {
  return value.replace(
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

/** Writes packaged assets and Xcode inputs before publishing the managed project directory. */
async function prepareIosInputs(
  project: Project,
  managed: string,
  signal: AbortSignal,
): Promise<string> {
  assertIosProject(project);
  const assets = resolve(managed, "assets/bunaway-assets");
  await mkdir(assets, {
    recursive: true,
  });
  await cp(
    resolve(project.frameworkRoot, "native/ios/host"),
    resolve(managed, "host"),
    {
      recursive: true,
    },
  );
  await runWorker(
    "assets.ts",
    "bundleIosAssets",
    [
      project,
      assets,
    ],
    project.root,
    project.frameworkRoot,
  );
  await writeFile(
    resolve(assets, "bridge.js"),
    await mobileBridge(project.frameworkRoot, "ios"),
  );
  await writeJson(resolve(assets, "host.json"), {
    view: project.app.view,
    home: new URL(project.app.home).href,
    title: project.app.title,
    policy: project.policy,
    ipc: PROCESS_IPC_VERSION,
    protocol: PROTOCOL_VERSION,
    limits: {
      messageBytes: MAX_MESSAGE_BYTES,
      depth: MAX_JSON_DEPTH,
      pending: API_LIMITS.maxPending,
      startupTimeoutMs: API_LIMITS.handshakeTimeoutMs,
    },
  });
  await writeJson(resolve(assets, "message.schema.json"), messageSchema);
  await writeFile(
    resolve(managed, "app.xcconfig"),
    `PRODUCT_BUNDLE_IDENTIFIER = ${project.app.appId}\n`,
  );
  await writeFile(
    resolve(managed, "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>
<key>CFBundleExecutable</key><string>$(EXECUTABLE_NAME)</string>
<key>CFBundleName</key><string>${plistText(project.app.title)}</string>
<key>CFBundleDisplayName</key><string>${plistText(project.app.title)}</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.0.0</string><key>CFBundleVersion</key><string>1</string>
<key>LSRequiresIPhoneOS</key><true/><key>UILaunchScreen</key><dict/>
<key>UISupportedInterfaceOrientations</key><array><string>UIInterfaceOrientationPortrait</string><string>UIInterfaceOrientationLandscapeLeft</string><string>UIInterfaceOrientationLandscapeRight</string></array>
</dict></plist>\n`,
  );
  return prepareIosRuntime(managed, project.frameworkRoot, signal);
}

/** Builds and validates the final Xcode identity, then publishes the Simulator app atomically. */
async function buildIosApp(
  project: Project,
  native: string,
  staging: string,
  bunRelease: string,
  signal: AbortSignal,
  device?: string,
): Promise<{
  app: string;
  appId: string;
}> {
  const paths = outputPaths(project.root, "ios");
  const app = resolve(paths.output, "Bunaway.app");
  const derived = resolve(staging, "DerivedData");
  await runManagedCommand(
    [
      "xcodebuild",
      "-project",
      resolve(native, "Bunaway.xcodeproj"),
      "-scheme",
      "Bunaway",
      "-configuration",
      "Debug",
      "-sdk",
      "iphonesimulator",
      "-destination",
      device ? `id=${device}` : "generic/platform=iOS Simulator",
      "-derivedDataPath",
      derived,
      "CODE_SIGNING_ALLOWED=NO",
      "ARCHS=arm64",
      "build",
    ],
    project.root,
    {},
    signal,
    project.frameworkRoot,
  );
  const identifierFile = resolve(staging, "bundle-id.txt");
  await runManagedCommand(
    [
      "/usr/bin/plutil",
      "-extract",
      "CFBundleIdentifier",
      "raw",
      "-o",
      identifierFile,
      resolve(
        derived,
        "Build/Products/Debug-iphonesimulator/Bunaway.app/Info.plist",
      ),
    ],
    project.root,
    {},
    signal,
    project.frameworkRoot,
  );
  const appId = (await readFile(identifierFile, "utf8")).trim();
  if (!IOS_BUNDLE_ID_PATTERN.test(appId)) {
    throw new Error("Xcode produced an invalid bundle identifier.");
  }
  const output = resolve(staging, "output");
  await mkdir(output);
  await cp(
    resolve(derived, "Build/Products/Debug-iphonesimulator/Bunaway.app"),
    resolve(output, "Bunaway.app"),
    {
      recursive: true,
    },
  );
  await writeJson(resolve(output, "manifest.json"), {
    format: 1,
    kind: "ios-simulator",
    appId,
    bunRelease,
    executableSha256: await hash(resolve(output, "Bunaway.app/Bunaway")),
  });
  signal.throwIfAborted();
  await publishOwnedDirectory(project.root, output, paths.output);
  return {
    app,
    appId,
  };
}

/** Installs and launches the built identity while the caller still owns the iOS output lock. */
async function installIosApp(
  project: Project,
  app: string,
  appId: string,
  device: string,
  signal: AbortSignal,
): Promise<void> {
  for (const args of [
    [
      "install",
      device,
      app,
    ],
    [
      "launch",
      "--terminate-running-process",
      device,
      appId,
    ],
  ]) {
    await runManagedCommand(
      [
        "xcrun",
        "simctl",
        ...args,
      ],
      project.root,
      {},
      signal,
      project.frameworkRoot,
    );
  }
}

/** Sync, optionally build and launch under one iOS output lock; previous app output survives failures. */
async function prepareIosProject(
  directory: string,
  build: boolean,
  device?: string,
): Promise<{
  project: string;
  app: string;
  appId: string;
}> {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("iOS builds require macOS arm64 and Xcode.");
  }
  const metadata = await readProjectMetadata(directory);
  assertIosProject(metadata);
  await mobileProjectExists(metadata.root, "ios");
  const paths = outputPaths(metadata.root, "ios");
  return withMobileBuild(metadata.root, "ios", async (staging, signal) => {
    await buildFrontend(metadata, signal);
    const project = await validateProject(metadata.root);
    assertIosProject(project);
    const managed = resolve(staging, "managed");
    const bunRelease = await prepareIosInputs(project, managed, signal);
    signal.throwIfAborted();
    const native = await publishIosProject(
      project.root,
      managed,
      project.frameworkRoot,
    );
    const built = build
      ? await buildIosApp(project, native, staging, bunRelease, signal, device)
      : {
          app: resolve(paths.output, "Bunaway.app"),
          appId: project.app.appId,
        };
    if (build && device) {
      await installIosApp(project, built.app, built.appId, device, signal);
    }
    return {
      project: native,
      ...built,
    };
  });
}

/** Bundle app.ts and web assets and sync an editable Xcode project. Preserves app-owned files. */
export async function syncIosProject(directory: string): Promise<string> {
  return (await prepareIosProject(directory, false)).project;
}
/** Sync and build an unsigned arm64 Simulator app with the pinned embedded runtime. */
export async function buildIosProject(directory: string): Promise<{
  app: string;
  appId: string;
}> {
  const { app, appId } = await prepareIosProject(directory, true);
  return {
    app,
    appId,
  };
}
/** Accept only complete UUID arguments for an explicitly selected Simulator. */
export function isIosSimulatorId(device: string): boolean {
  return /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$(?![\s\S])/i.test(device);
}

/** Build, install and launch on an explicitly selected, already booted Simulator UUID. */
export async function runIosProject(
  directory: string,
  device: string,
): Promise<void> {
  if (!isIosSimulatorId(device)) {
    throw new Error("iOS run requires a Simulator UUID.");
  }
  await prepareIosProject(directory, true, device);
}
