import { dlopen, type Pointer, ptr } from "bun:ffi";
import assert from "node:assert/strict";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { OLE32, pick, SHELL32 } from "@bunaway/plugin/win32";
import { type HostContext, parsePolicy } from "@bunaway/protocol";
import { readAppManifest } from "@bunaway/runtime-bun/app-manifest";
import {
  appName,
  desktopAppPaths,
  parsePluginSettings,
  readPackageVersions,
} from "@bunaway/runtime-bun/app-metadata";
import {
  verifyDevelopmentLaunch,
  verifyDevelopmentToolsLaunch,
} from "@bunaway/runtime-bun/development";
import { readWindowSpecs } from "@bunaway/runtime-bun/window-config";
import pin from "../../../runtime/build-manifests/windows-x64.json";
import type { UIConfig } from "./channel.ts";
import { readWideString } from "./wide-string.ts";

/** Compiled apps read embedded assets; development apps read the package directory. */
export const isCompiledApp = Bun.embeddedFiles.some(
  (file) => (file as File).name === "manifest.json",
);

/** Returns LocalAppData and releases its Win32 path buffer and DLL handles. */
export function localAppData() {
  const shell = dlopen("shell32.dll", {
    ...pick(SHELL32, "SHGetKnownFolderPath"),
  });
  const ole = dlopen("ole32.dll", {
    ...pick(OLE32, "CoTaskMemFree"),
  });
  const out = new BigUint64Array(1);
  try {
    const guid = Buffer.from("8527b3f1ba6fcf4f9d557b8e7f157091", "hex");
    assert.equal(
      shell.symbols.SHGetKnownFolderPath(ptr(guid), 0, 0n, ptr(out)),
      0,
    );
    const address = Number(out[0]) as Pointer;
    assert(address);
    const path = readWideString(address, 65536);
    assert(path !== null);
    return path;
  } finally {
    if (out[0]) {
      ole.symbols.CoTaskMemFree(Number(out[0]) as Pointer);
    }
    shell.close();
    ole.close();
  }
}

/**
 * Validates a packaged or development app and resolves host paths
 * and runtime settings. Rejects unsupported platforms and Bun builds.
 */
export async function verifyWindowsPackage(
  directory: string,
  developmentUrl?: string,
  developmentTools = false,
): Promise<UIConfig> {
  assert.equal(process.platform, "win32");
  assert.equal(process.arch, "x64");
  assert.equal(Bun.version, pin.bun.version);
  assert.equal(Bun.revision, pin.bun.sourceRevision);
  // Bun consumes BUN_OPTIONS/BUN_BE_BUN before application code. The local launch
  // environment is trusted; compile disables cwd config loading, not user overrides.
  const root = await realpath(resolve(directory));
  const assets = isCompiledApp ? import.meta.dir : resolve(root, "assets");
  const manifest = await readAppManifest(assets);
  const config = manifest.app;
  const devUrl = verifyDevelopmentLaunch(config.development, developmentUrl);
  const devtools = verifyDevelopmentToolsLaunch(
    config.developmentTools,
    developmentTools,
  );
  assert(
    typeof config.appId === "string" &&
      /^[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/.test(config.appId),
    "Invalid app id",
  );
  const policy = parsePolicy(JSON.stringify(manifest.policy));
  const executablePath = await realpath(process.execPath);
  const specs = [
    {
      view: config.view,
      home: config.home,
      title: config.title,
      window: config.window,
      startup: config.startup,
      visible: config.visible,
      showWhenReady: config.showWhenReady,
    },
  ];
  const windows = readWindowSpecs(specs, policy, devUrl);
  const versions = await readPackageVersions(root);
  return {
    appMetadata: {
      name: appName(config.title, config.appId),
      identifier: config.appId,
      ...versions,
      isPackaged: isCompiledApp,
      paths: desktopAppPaths(root, executablePath),
    },
    app: {
      id: config.appId,
      version: versions.version,
      ...(config.pluginSettings === undefined
        ? {}
        : {
            pluginSettings: parsePluginSettings(config.pluginSettings),
          }),
      launch: {
        mode: isCompiledApp ? "packaged" : "development",
        executablePath,
        args: isCompiledApp
          ? []
          : [
              "--no-env-file",
              "--no-install",
              `--config=${resolve(assets, "bunfig.toml")}`,
              `--tsconfig-override=${resolve(assets, "tsconfig.json")}`,
              await realpath(resolve(assets, "boot.js")),
            ],
      },
    },
    runtime: {
      id: config.appId,
      generation: crypto.randomUUID(),
    },
    backendContext: `backend-${crypto.randomUUID()}` as HostContext,
    policy,
    windows,
    assets,
    loader: resolve(
      root,
      isCompiledApp ? "WebView2Loader.dll" : "assets/WebView2Loader.dll",
    ),
    ...(config.icon
      ? {
          icon: isCompiledApp ? process.execPath : resolve(assets, "app.ico"),
        }
      : {}),
    legacyProfile: true,
    devtools,
    dataRoot: resolve(localAppData(), "bunaway", config.appId),
  };
}
