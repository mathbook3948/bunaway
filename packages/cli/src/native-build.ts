import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { frameworkRoot, json, verifyHash } from "./files.ts";
import { run } from "./processes.ts";

function record(value: unknown): Record<string, unknown> {
  assert(
    value && typeof value === "object" && !Array.isArray(value),
    "Invalid dependency manifest",
  );
  return value as Record<string, unknown>;
}
function string(value: unknown): string {
  assert(
    typeof value === "string" && value.length > 0,
    "Invalid dependency manifest field",
  );
  return value;
}

/** Download only missing inputs, verify before publishing, and leave no partial cache entry on failure. */
export async function fetchDependency(
  url: string,
  path: string,
  expected: string,
  verifyOnly = false,
): Promise<void> {
  if (await Bun.file(path).exists()) {
    await verifyHash(path, expected);
    return;
  }
  assert(!verifyOnly, `Missing dependency: ${path}`);
  assert(
    new URL(url).protocol === "https:",
    "Dependency downloads require HTTPS",
  );
  await mkdir(dirname(path), {
    recursive: true,
  });
  const stage = await mkdtemp(`${path}.download-`);
  try {
    const response = await fetch(url);
    assert(response.ok, `Download failed (${response.status}): ${url}`);
    const temporary = resolve(stage, "download");
    await Bun.write(temporary, response);
    await verifyHash(temporary, expected);
    await rename(temporary, path);
  } finally {
    await rm(stage, {
      recursive: true,
      force: true,
    });
  }
}

/** Prepare pinned native inputs with the running Bun; verify-only never downloads, extracts or compiles. */
export async function prepareNativeBuild(
  target: "windows-x64" | "macos-arm64",
  root = frameworkRoot,
  verifyOnly = false,
): Promise<void> {
  const windows = target === "windows-x64";
  assert(
    windows
      ? process.platform === "win32" && process.arch === "x64"
      : process.platform === "darwin" && process.arch === "arm64",
    `Native build requires ${target}`,
  );
  const manifest = record(
    await json(
      resolve(
        root,
        "runtime/build-manifests",
        windows ? "windows-x64.json" : "darwin-aarch64.json",
      ),
    ),
  );
  const bun = record(manifest.bun);
  const bunTarget = windows ? "windows-x64-baseline" : "darwin-aarch64";
  assert(bun.target === bunTarget, "Unexpected Bun target");
  assert(
    Bun.version === string(bun.version),
    "Build Bun version must match the pin",
  );
  const cache = resolve(root, "build/cache/bun");
  const archive = resolve(cache, `bun-${bunTarget}.zip`);
  const fetchPinned = (url: unknown, path: string, digest: unknown) =>
    fetchDependency(string(url), path, string(digest), verifyOnly);
  await fetchPinned(bun.archiveUrl, archive, bun.archiveSha256);
  const executable = resolve(
    cache,
    `bun-${bunTarget}`,
    windows ? "bun.exe" : "bun",
  );
  if (!(await Bun.file(executable).exists()) && !verifyOnly) {
    await run(
      windows
        ? [
            "tar",
            "-xf",
            archive,
            "-C",
            cache,
          ]
        : [
            "/usr/bin/ditto",
            "-xk",
            archive,
            cache,
          ],
      root,
    );
  }
  await verifyHash(executable, string(bun.executableSha256));
  await fetchPinned(
    bun.licenseUrl,
    resolve(cache, "LICENSE.bun"),
    bun.licenseSha256,
  );
  if (windows) {
    const sdk = record(
      record(await json(resolve(root, "native/windows/bun/deps.json")))
        .webview2Sdk,
    );
    const vendor = resolve(root, "build/cache/webview2");
    const sdkArchive = resolve(vendor, `webview2-${string(sdk.version)}.nupkg`);
    await fetchPinned(sdk.archiveUrl, sdkArchive, sdk.archiveSha256);
    const extracted = resolve(vendor, "sdk");
    if (
      !(await Bun.file(
        resolve(extracted, "build/native/x64/WebView2Loader.dll"),
      ).exists()) &&
      !verifyOnly
    ) {
      await mkdir(extracted, {
        recursive: true,
      });
      await run(
        [
          "tar",
          "-xf",
          sdkArchive,
          "-C",
          extracted,
        ],
        root,
      );
    }
    const hashes = record(sdk.files);
    for (const file of [
      "build/native/x64/WebView2Loader.dll",
      "LICENSE.txt",
    ]) {
      await verifyHash(resolve(extracted, file), string(hashes[file]));
    }
    return;
  }
  const header = record(manifest.json);
  const vendor = resolve(root, "build/cache/nlohmann-json");
  await fetchPinned(
    header.headerUrl,
    resolve(vendor, "json.hpp"),
    header.headerSha256,
  );
  await fetchPinned(
    header.licenseUrl,
    resolve(vendor, "LICENSE.nlohmann-json"),
    header.licenseSha256,
  );
  if (verifyOnly) {
    return;
  }
  await chmod(executable, 0o755);
  const architecture = Bun.spawn(
    [
      "/usr/bin/lipo",
      "-archs",
      executable,
    ],
    {
      stdout: "pipe",
      stderr: "inherit",
    },
  );
  const architectureOutput = (
    await new Response(architecture.stdout).text()
  ).trim();
  const architectureCode = await architecture.exited;
  assert(
    architectureOutput === "arm64" && architectureCode === 0,
    "Bundled Bun must be arm64",
  );
  const version = Bun.spawn(
    [
      executable,
      "--version",
    ],
    {
      stdout: "pipe",
      stderr: "inherit",
    },
  );
  const versionOutput = (await new Response(version.stdout).text()).trim();
  const versionCode = await version.exited;
  assert(
    versionOutput === bun.version && versionCode === 0,
    "Bundled Bun version mismatch",
  );
  await mkdir(resolve(root, "build/macos-host"), {
    recursive: true,
  });
  await run(
    [
      "clang++",
      "-std=c++20",
      "-O2",
      "-Wall",
      "-Wextra",
      "-fobjc-arc",
      `-I${vendor}`,
      resolve(root, "native/macos/host/main.mm"),
      "-framework",
      "Cocoa",
      "-framework",
      "WebKit",
      "-o",
      resolve(root, "build/macos-host/bunaway-host"),
    ],
    root,
  );
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      target: {
        type: "string",
      },
      "verify-only": {
        type: "boolean",
        default: false,
      },
    },
  });
  assert(
    values.target === "windows-x64" || values.target === "macos-arm64",
    "--target must be windows-x64 or macos-arm64",
  );
  await prepareNativeBuild(values.target, frameworkRoot, values["verify-only"]);
}
