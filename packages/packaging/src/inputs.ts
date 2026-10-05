import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  type BuildArtifact,
  type BuildTarget,
  CODES,
  type Diagnostic,
  type PackageManifest,
  packagedDigest,
  platformOf,
  type ChannelId,
} from "./contract.ts";

// Locates the channel-neutral artifact produced by `bunaway build`.
// Windows: dist/windows-x64/{bunaway-host.exe, runtime/, assets/, licenses/,
// manifest.json}. macOS: dist/macos-arm64/<appId>.app with the package root at
// Contents/Resources. Adapters must treat these files as read-only.
export function artifactPaths(args: {
  root: string;
  target: BuildTarget;
  appId: string;
}): BuildArtifact {
  const { root, target, appId } = args;
  if (target === "windows-x64") {
    const dir = resolve(root, "dist/windows-x64");
    return { dir, packageDir: dir, executable: resolve(dir, "bunaway-host.exe") };
  }
  const dir = resolve(root, "dist/macos-arm64", `${appId}.app`);
  return {
    dir,
    packageDir: resolve(dir, "Contents/Resources"),
    executable: resolve(dir, "Contents/MacOS/bunaway-host"),
  };
}

async function exists(path: string, file = true): Promise<boolean> {
  const stat = await lstat(path).catch(() => undefined);
  return file ? (stat?.isFile() ?? false) : (stat?.isDirectory() ?? false);
}

export async function loadManifest(artifact: BuildArtifact): Promise<PackageManifest> {
  const path = resolve(artifact.packageDir, "manifest.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error(`Cannot read package manifest: ${path} (run bunaway build first).`);
  }
  const manifest = parsed as PackageManifest;
  if (
    typeof manifest.bun?.executableSha256 !== "string" ||
    !manifest.assets ||
    typeof manifest.app?.id !== "string"
  ) {
    throw new Error(`Package manifest is missing required fields: ${path}`);
  }
  return manifest;
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

// The built-in verify stage: re-hashes every asset the manifest lists plus the
// bundled runtime before an adapter is allowed to stage anything. Missing
// files and digest mismatches are diagnosed separately so tampering cannot
// masquerade as a missing input.
export async function verifyArtifact(args: {
  artifact: BuildArtifact;
  manifest: PackageManifest;
  channel: ChannelId;
}): Promise<Diagnostic[]> {
  const { artifact, manifest, channel } = args;
  const diagnostics: Diagnostic[] = [];
  const stage = "verify";
  const platform = platformOf(channel);
  if (!(await exists(artifact.packageDir, false))) {
    diagnostics.push({
      stage,
      code: CODES.INPUT_MISSING,
      severity: "error",
      message: "Build artifact is missing; run bunaway build first.",
      path: artifact.packageDir,
    });
    return diagnostics;
  }
  if (!(await exists(artifact.executable))) {
    diagnostics.push({
      stage,
      code: CODES.INPUT_MISSING,
      severity: "error",
      message: "Host executable is missing from the build artifact.",
      path: artifact.executable,
    });
  } else {
    // sourceSha256 predates macOS bundle signing and is provenance, not a final digest.
    const expected = manifest.host?.packagedSha256 ?? manifest.host?.sha256;
    if (!expected && platform === "windows") {
      diagnostics.push({
        stage,
        code: CODES.INPUT_MISSING,
        severity: "error",
        message: "Build manifest is missing the host executable hash; run bunaway build again.",
        path: artifact.executable,
      });
    } else if (expected && (await sha256(artifact.executable)) !== expected) {
      diagnostics.push({
        stage,
        code: CODES.INPUT_TAMPERED,
        severity: "error",
        message: "Host executable hash mismatch.",
        path: artifact.executable,
      });
    }
  }
  const runtime = resolve(
    artifact.packageDir,
    platform === "windows" ? "runtime/bun.exe" : "runtime/bun",
  );
  if (!(await exists(runtime))) {
    diagnostics.push({
      stage,
      code: CODES.INPUT_MISSING,
      severity: "error",
      message: "Bundled Bun runtime is missing from the build artifact.",
      path: runtime,
    });
  } else {
    const expected = packagedDigest(manifest.bun);
    const actual = await sha256(runtime);
    if (expected && actual !== expected) {
      diagnostics.push({
        stage,
        code: CODES.INPUT_TAMPERED,
        severity: "error",
        message: `Bundled Bun hash mismatch (manifest ${expected}, file ${actual}).`,
        path: runtime,
      });
    }
  }
  for (const [relative, expected] of Object.entries(manifest.assets)) {
    const path = resolve(artifact.packageDir, relative);
    if (!(await exists(path))) {
      diagnostics.push({
        stage,
        code: CODES.INPUT_MISSING,
        severity: "error",
        message: `Manifest asset is missing: ${relative}`,
        path,
      });
      continue;
    }
    const actual = await sha256(path);
    if (actual !== expected) {
      diagnostics.push({
        stage,
        code: CODES.INPUT_TAMPERED,
        severity: "error",
        message: `Asset hash mismatch: ${relative}`,
        path,
      });
    }
  }
  return diagnostics;
}
