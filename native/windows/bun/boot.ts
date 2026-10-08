import { dlopen, type Pointer, ptr, read, toArrayBuffer } from "bun:ffi";
import assert from "node:assert/strict";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import type { AppDefinition } from "../../../packages/core/src/index.ts";
import {
  type HostContext,
  parsePolicy,
} from "../../../packages/protocol/src/index.ts";
import {
  verifyDevelopmentLaunch,
  verifyDevelopmentToolsLaunch,
} from "../../../packages/runtime-bun/src/development.ts";
import { readWindowSpecs } from "../../../packages/runtime-bun/src/window-config.ts";
import pin from "../../../runtime/build-manifests/windows-x64.json";
import type { UIConfig } from "./channel.ts";
import { runWindowsApp } from "./entry.ts";
import {
  forwardToInstance,
  instanceAddress,
  listenForInstances,
  parseLaunchArguments,
} from "./instance.ts";
import { AppAlreadyRunningError, containAppProcess } from "./job.ts";

const compiled = Bun.embeddedFiles.some(
  (file) => (file as File).name === "app.json",
);
function object(value: unknown): Record<string, unknown> {
  assert(
    value && typeof value === "object" && !Array.isArray(value),
    "Invalid package configuration",
  );
  return value as Record<string, unknown>;
}
function localAppData() {
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
  const assets = compiled ? import.meta.dir : resolve(root, "assets");
  const config = object(
    JSON.parse(await readFile(resolve(assets, "app.json"), "utf8")),
  );
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
  const policy = parsePolicy(
    await readFile(resolve(assets, "policy.json"), "utf8"),
  );
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
      compiled ? "WebView2Loader.dll" : "assets/WebView2Loader.dll",
    ),
    ...(config.icon
      ? {
          icon: compiled ? process.execPath : resolve(assets, "app.ico"),
        }
      : {}),
    legacyProfile: !Array.isArray(config.windows),
    devtools,
    dataRoot: resolve(localAppData(), "bunaway", config.appId),
  };
}

if (import.meta.main) {
  let dataRoot: string | undefined;
  let title = "Bunaway";
  try {
    dataRoot = resolve(
      localAppData(),
      "bunaway",
      basename(process.execPath, ".exe"),
    );
    const root = compiled
      ? dirname(process.execPath)
      : resolve(import.meta.dir, "..");
    const args = process.argv.slice(2);
    const devtools = !compiled && args[0] === "--devtools";
    if (devtools) {
      args.shift();
    }
    const developmentUrl =
      !compiled && args[0] === "--dev-url" ? args[1] : undefined;
    if (!compiled && args[0] === "--dev-url") {
      assert(developmentUrl, "Missing development URL");
    }
    const config = await verifyWindowsPackage(root, developmentUrl, devtools);
    dataRoot = config.dataRoot;
    title = config.windows[0]?.title ?? title;
    const launch = parseLaunchArguments({
      argv: developmentUrl ? args.slice(2) : args,
      cwd: process.cwd(),
    });
    try {
      containAppProcess(config.dataRoot);
    } catch (error) {
      if (!(error instanceof AppAlreadyRunningError)) {
        throw error;
      }
      await forwardToInstance(instanceAddress(config.dataRoot), launch);
      process.exit(0);
    }
    const inbox = await listenForInstances(instanceAddress(config.dataRoot));
    try {
      // Only the owner imports the app after IPC readiness. This literal also lets
      // bun build --compile include the application and its shared core chunk.
      // @ts-expect-error app.js is supplied by the host bundler.
      const module = await import("./app.js");
      const app = object(module.default);
      assert(
        app.commands && app.events,
        "App must default-export an AppDefinition",
      );
      await runWindowsApp(app as AppDefinition, config, launch, inbox);
    } finally {
      // runWindowsApp also closes on shutdown; early import failures need this path.
      await inbox.close().catch(() => {});
    }
    process.exit(0);
  } catch (error) {
    console.error(error);
    if (compiled) {
      await reportWindowsFailure(error, dataRoot, title);
    }
    process.exit(1);
  }
}

export async function reportWindowsFailure(
  error: unknown,
  dataRoot: string | undefined,
  title: string,
) {
  const message = (
    error instanceof Error ? (error.stack ?? error.message) : String(error)
  ).slice(0, 16384);
  let detail = message;
  if (dataRoot) {
    const log = resolve(dataRoot, "logs/startup-error.log");
    try {
      await mkdir(dirname(log), {
        recursive: true,
      });
      await writeFile(log, message, "utf8");
      detail = `${message}\n\nLog: ${log}`;
    } catch {
      /* A startup failure must still be visible if the log cannot be written. */
    }
  }
  const user = dlopen("user32.dll", {
    MessageBoxW: {
      args: [
        "u64",
        "ptr",
        "ptr",
        "u32",
      ],
      returns: "i32",
    },
  });
  const text = Buffer.from(`${detail}\0`, "utf16le");
  const caption = Buffer.from(`${title}\0`, "utf16le");
  try {
    user.symbols.MessageBoxW(0n, ptr(text), ptr(caption), 0x10);
  } finally {
    user.close();
  }
}
