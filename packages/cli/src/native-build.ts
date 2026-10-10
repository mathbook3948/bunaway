import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
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

/** Extract pinned ZIPs using ASCII relative names on Windows, where tar cannot open Unicode absolute paths. */
export async function extractDependencyArchive(
  archive: string,
  directory: string,
): Promise<void> {
  const cwd = dirname(archive);
  await run(
    process.platform === "win32"
      ? [
          "tar",
          "-xf",
          basename(archive),
          "-C",
          relative(cwd, directory) || ".",
        ]
      : [
          "/usr/bin/ditto",
          "-xk",
          archive,
          directory,
        ],
    cwd,
  );
}

/** Prepare pinned native inputs with the running Bun; verify-only never downloads or extracts. */
export async function prepareNativeBuild(
  target: "windows-x64" | "macos-arm64" | "android",
  root = frameworkRoot,
  verifyOnly = false,
): Promise<void> {
  if (target === "android") {
    await prepareAndroidBuild(root, verifyOnly);
    return;
  }
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
  if (!windows) {
    await verifyHash(process.execPath, string(bun.executableSha256));
    return;
  }
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
    await extractDependencyArchive(archive, cache);
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
      await extractDependencyArchive(sdkArchive, extracted);
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
}

/** Verify both Android ABI pins before preparing their archives, executables and licenses. */
async function prepareAndroidBuild(
  root: string,
  verifyOnly: boolean,
): Promise<void> {
  assert(
    process.platform === "win32",
    "Android builds currently require Windows.",
  );
  const pins = await Promise.all(
    (
      [
        "x64",
        "arm64",
      ] as const
    ).map(async (architecture) => {
      const manifest = record(
        await json(
          resolve(root, `runtime/build-manifests/android-${architecture}.json`),
        ),
      );
      const bun = record(manifest.bun);
      const target =
        architecture === "x64"
          ? "linux-x64-android-baseline"
          : "linux-aarch64-android";
      assert(bun.target === target, "Unexpected Android Bun target");
      assert(
        Bun.version === string(bun.version),
        "Build Bun version must match the Android pin",
      );
      return {
        bun,
        target,
        cache: resolve(root, `build/cache/android-bun/${architecture}`),
      };
    }),
  );
  for (const { bun, target, cache } of pins) {
    const archive = resolve(cache, `bun-${target}.zip`);
    await fetchDependency(
      string(bun.archiveUrl),
      archive,
      string(bun.archiveSha256),
      verifyOnly,
    );
    const executable = resolve(cache, `bun-${target}/bun`);
    if (!(await Bun.file(executable).exists()) && !verifyOnly) {
      await extractDependencyArchive(archive, cache);
    }
    await verifyHash(executable, string(bun.executableSha256));
    await fetchDependency(
      string(bun.licenseUrl),
      resolve(cache, "LICENSE.bun"),
      string(bun.licenseSha256),
      verifyOnly,
    );
  }
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
    values.target === "windows-x64" ||
      values.target === "macos-arm64" ||
      values.target === "android",
    "--target must be windows-x64, macos-arm64 or android",
  );
  await prepareNativeBuild(values.target, frameworkRoot, values["verify-only"]);
}
