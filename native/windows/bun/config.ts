import { dlopen, type Pointer, ptr, read, toArrayBuffer } from "bun:ffi";
import assert from "node:assert/strict";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import {
  type HostContext,
  parsePolicy,
} from "../../../packages/protocol/src/index.ts";
import { readAppManifest } from "../../../packages/runtime-bun/src/app-manifest.ts";
import {
  verifyDevelopmentLaunch,
  verifyDevelopmentToolsLaunch,
} from "../../../packages/runtime-bun/src/development.ts";
import { readWindowSpecs } from "../../../packages/runtime-bun/src/window-config.ts";
import pin from "../../../runtime/build-manifests/windows-x64.json";
import type { UIConfig } from "./channel.ts";

/** Compiled apps read embedded assets; development apps read the package directory. */
export const isCompiledApp = Bun.embeddedFiles.some(
  (file) => (file as File).name === "manifest.json",
);

/** Returns LocalAppData and releases its Win32 path buffer and DLL handles. */
export function localAppData() {
  const shell = dlopen("shell32.dll", {
    SHGetKnownFolderPath: {
      args: [
        "ptr",
        "u32",
        "u64",
        "ptr",
      ],
      returns: "i32",
    },
  });
  const ole = dlopen("ole32.dll", {
    CoTaskMemFree: {
      args: [
        "ptr",
      ],
      returns: "void",
    },
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
    let length = 0;
    while (length < 65536 && read.u16(address, length)) {
      length += 2;
    }
    assert(length < 65536);
    return Buffer.from(toArrayBuffer(address, 0, length)).toString("utf16le");
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
  const specs = config.windows ?? [
    {
      view: config.view,
      home: config.home,
      title: config.title,
      window: config.window,
    },
  ];
  const windows = readWindowSpecs(specs, policy, devUrl);
  return {
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
    legacyProfile: !Array.isArray(config.windows),
    devtools,
    dataRoot: resolve(localAppData(), "bunaway", config.appId),
  };
}
