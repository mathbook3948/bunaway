import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, readFile, realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep, win32 } from "node:path";
import { XMLParser } from "fast-xml-parser";
import {
  type BuildArtifact,
  type BuildTarget,
  type ChannelId,
  CODES,
  type Diagnostic,
  type PackageManifest,
  packagedDigest,
  platformOf,
} from "./contract.ts";

// Locates the channel-neutral artifact produced by `bunaway build`.
// Windows: dist/windows-x64/{<app>.exe, WebView2Loader.dll, licenses/, manifest.json}.
// macOS: dist/macos-arm64/<appId>.app with the package root at
// Contents/Resources. Adapters must treat these files as read-only.
export function artifactPaths(args: {
  root: string;
  target: BuildTarget;
  appId: string;
  executableName?: string;
}): BuildArtifact {
  const { root, target, appId } = args;
  if (target === "windows-x64") {
    const dir = resolve(root, "dist/windows-x64");
    return {
      dir,
      packageDir: dir,
      executable: resolve(dir, args.executableName ?? `${appId}.exe`),
    };
  }
  const dir = resolve(root, "dist/macos-arm64", `${appId}.app`);
  return {
    dir,
    packageDir: resolve(dir, "Contents/Resources"),
    executable: resolve(dir, "Contents/MacOS/bunaway-host"),
  };
}

export class ArtifactInputError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

async function inputPath(
  root: string,
  path: string,
  directory = false,
): Promise<string> {
  if (!inside(root, path)) {
    throw new ArtifactInputError(
      CODES.INPUT_UNEXPECTED,
      `Input path escapes the build artifact: ${path}`,
    );
  }
  const rootStat = await lstat(root).catch(() => undefined);
  const stat = await lstat(path).catch(() => undefined);
  if (
    !rootStat?.isDirectory() ||
    !(directory ? stat?.isDirectory() : stat?.isFile())
  ) {
    throw new ArtifactInputError(
      CODES.INPUT_MISSING,
      `Build input is missing or not a regular ${directory ? "directory" : "file"}: ${path}`,
    );
  }
  const canonicalRoot = await realpath(root);
  const canonicalPath = await realpath(path);
  if (!inside(canonicalRoot, canonicalPath)) {
    throw new ArtifactInputError(
      CODES.INPUT_UNEXPECTED,
      `Input real path escapes the build artifact: ${path}`,
    );
  }
  return canonicalPath;
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isIdentity(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.trim() === value
  );
}

type XmlNode = Record<string, XmlNode[] | string>;

function plistContent(node: XmlNode | undefined, tag: string): XmlNode[] {
  const children = node?.[tag];
  if (!node || Object.keys(node).length !== 1 || !Array.isArray(children)) {
    throw new Error(`Expected a plist ${tag} element.`);
  }
  return children;
}

function plistChildren(node: XmlNode | undefined, tag: string): XmlNode[] {
  return plistContent(node, tag).filter((child) => {
    const text = child["#text"];
    return typeof text !== "string" || text.trim().length > 0;
  });
}

function plistString(node: XmlNode | undefined, tag: string): string {
  return plistContent(node, tag)
    .map((child) => {
      if (Object.keys(child).length !== 1) {
        throw new Error(`Expected plist ${tag} text.`);
      }
      if (typeof child["#text"] === "string") {
        return xmlText(child["#text"]);
      }
      const cdata = child["#cdata"];
      if (
        Array.isArray(cdata) &&
        cdata.length === 1 &&
        typeof cdata[0]?.["#text"] === "string"
      ) {
        return cdata[0]["#text"];
      }
      throw new Error(`Expected plist ${tag} text.`);
    })
    .join("");
}

function xmlText(text: string): string {
  const entities: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
  };
  return text.replace(/&([^;]*);|&/g, (_match, entity: string | undefined) => {
    if (entity && Object.hasOwn(entities, entity)) {
      return entities[entity] ?? "";
    }
    if (entity && /^#(?:[0-9]+|x[0-9a-fA-F]+)$/.test(entity)) {
      const point = entity.startsWith("#x")
        ? Number.parseInt(entity.slice(2), 16)
        : Number(entity.slice(1));
      if (
        point === 9 ||
        point === 10 ||
        point === 13 ||
        (point >= 0x20 && point <= 0xd7ff) ||
        (point >= 0xe000 && point <= 0xfffd) ||
        (point >= 0x10000 && point <= 0x10ffff)
      ) {
        return String.fromCodePoint(point);
      }
    }
    throw new Error(`Invalid XML entity: &${entity ?? ""};`);
  });
}

function plistDictionary(node: XmlNode | undefined): Map<string, XmlNode> {
  const entries = plistChildren(node, "dict");
  const metadata = new Map<string, XmlNode>();
  for (let i = 0; i < entries.length; i += 2) {
    const key = plistString(entries[i], "key");
    const value = entries[i + 1];
    if (!value || metadata.has(key)) {
      throw new Error(`Invalid or duplicate plist entry: ${key}`);
    }
    validatePlistValue(value);
    metadata.set(key, value);
  }
  return metadata;
}

function validatePlistValue(node: XmlNode): void {
  const tag = Object.keys(node)[0] ?? "";
  if (tag === "dict") {
    plistDictionary(node);
    return;
  }
  if (tag === "array") {
    for (const value of plistChildren(node, tag)) {
      validatePlistValue(value);
    }
    return;
  }
  if (tag === "true" || tag === "false") {
    if (plistContent(node, tag).length !== 0) {
      throw new Error(`Non-empty plist ${tag}.`);
    }
    return;
  }
  if (
    ![
      "string",
      "integer",
      "real",
      "date",
      "data",
    ].includes(tag)
  ) {
    throw new Error(`Invalid plist value: ${tag}`);
  }
  const text = plistString(node, tag);
  if (tag === "string") {
    return;
  }
  const value = text.trim();
  const valid =
    tag === "integer"
      ? /^[+-]?(?:0[xX][0-9a-fA-F]+|[0-9]+)$/.test(value)
      : tag === "real"
        ? /^[+-]?(?:(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?|inf(?:inity)?|nan)$/i.test(
            value,
          )
        : tag === "date"
          ? /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value) &&
            Number.isFinite(Date.parse(value))
          : /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
              text.replace(/\s/g, ""),
            );
  if (!valid) {
    throw new Error(`Invalid plist ${tag} value.`);
  }
}

function bundleMetadata(xml: string): Map<string, XmlNode> {
  const parser = new XMLParser({
    preserveOrder: true,
    parseTagValue: false,
    trimValues: false,
    ignoreDeclaration: true,
    ignorePiTags: true,
    processEntities: false,
    cdataPropName: "#cdata",
  });
  const roots = parser.parse(xml, true) as XmlNode[];
  if (roots.length !== 1) {
    throw new Error("Expected one plist root.");
  }
  const plist = plistChildren(roots[0], "plist");
  if (plist.length !== 1) {
    throw new Error("Expected one plist dictionary.");
  }
  return plistDictionary(plist[0]);
}

function validateManifest(value: unknown): asserts value is PackageManifest {
  if (
    !isRecord(value) ||
    !isRecord(value.bun) ||
    !isIdentity(value.bun.version) ||
    !isIdentity(value.bun.sourceRevision) ||
    !isDigest(value.bun.executableSha256) ||
    !isDigest(value.bun.licenseSha256) ||
    !isRecord(value.assets) ||
    !isRecord(value.app) ||
    typeof value.app.id !== "string"
  ) {
    throw new ArtifactInputError(
      CODES.INPUT_MISSING,
      "Package manifest is missing required fields.",
    );
  }
  for (const key of [
    "packagedSha256",
    "sha256",
    "sourceSha256",
  ]) {
    if (value.bun[key] !== undefined && !isDigest(value.bun[key])) {
      throw new ArtifactInputError(
        CODES.INPUT_MISSING,
        `Package manifest has an invalid bun.${key} digest.`,
      );
    }
  }
  for (const [path, digest] of Object.entries(value.assets)) {
    if (
      isAbsolute(path) ||
      win32.parse(path).root !== "" ||
      path.includes("\\") ||
      path
        .split("/")
        .some((part) => part === "" || part === "." || part === "..")
    ) {
      throw new ArtifactInputError(
        CODES.INPUT_UNEXPECTED,
        `Manifest asset path must be relative and cannot escape the package: ${path}`,
      );
    }
    if (!isDigest(digest)) {
      throw new ArtifactInputError(
        CODES.INPUT_MISSING,
        `Manifest asset has an invalid digest: ${path}`,
      );
    }
  }
}

const REQUIRED_ASSETS = {
  windows: [
    "WebView2Loader.dll",
    "licenses/LICENSE.bun",
    "licenses/License-WebView2.txt",
  ],
  macos: [
    "assets/app.json",
    "assets/policy.json",
    "assets/backend.js",
    "assets/bunfig.toml",
    "assets/tsconfig.json",
    "assets/process.schema.json",
    "assets/message.schema.json",
    "assets/host-call.schema.json",
    "assets/policy.schema.json",
    "licenses/LICENSE.bun",
    "licenses/LICENSE.nlohmann-json",
  ],
};

function homeAsset(value: unknown): string {
  if (!isIdentity(value)) {
    throw new ArtifactInputError(
      CODES.INPUT_MISSING,
      "Build app config is missing its home URL.",
    );
  }
  let url: URL;
  let path: string;
  try {
    url = new URL(value);
    path = decodeURIComponent(url.pathname);
  } catch {
    throw new ArtifactInputError(
      CODES.INPUT_UNEXPECTED,
      "Build app config has an invalid home URL.",
    );
  }
  if (
    url.origin !== "https://app.bunaway.local" ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new ArtifactInputError(
      CODES.INPUT_UNEXPECTED,
      "Home must use the host-owned https://app.bunaway.local origin.",
    );
  }
  if (path === "/") {
    path = "/index.html";
  }
  const name = path.slice(1);
  if (
    name.includes("\\") ||
    name.includes("\0") ||
    name.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new ArtifactInputError(
      CODES.INPUT_UNEXPECTED,
      "Home document path must stay inside assets/web.",
    );
  }
  return `assets/web/${name}`;
}

export async function loadManifest(
  artifact: BuildArtifact,
): Promise<PackageManifest> {
  const path = resolve(artifact.packageDir, "manifest.json");
  const canonicalPath = await inputPath(artifact.dir, path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(canonicalPath, "utf8"));
  } catch {
    throw new Error(
      `Cannot read package manifest: ${path} (run bunaway build first).`,
    );
  }
  validateManifest(parsed);
  return parsed;
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
  const manifestPath = resolve(artifact.packageDir, "manifest.json");
  try {
    await inputPath(artifact.dir, artifact.packageDir, true);
    await inputPath(artifact.packageDir, manifestPath);
    validateManifest(manifest);
  } catch (error) {
    diagnostics.push({
      stage,
      code:
        error instanceof ArtifactInputError ? error.code : CODES.INPUT_MISSING,
      severity: "error",
      message: error instanceof Error ? error.message : String(error),
      path: manifestPath,
    });
    return diagnostics;
  }

  async function verifyFile(
    root: string,
    path: string,
    label: string,
    expected?: string,
    executable = false,
  ) {
    try {
      const canonicalPath = await inputPath(root, path);
      // Windows does not expose POSIX execute permissions.
      if (executable && process.platform !== "win32") {
        try {
          await access(canonicalPath, constants.X_OK);
        } catch {
          throw new ArtifactInputError(
            CODES.INPUT_TAMPERED,
            "Build input is not executable.",
          );
        }
      }
      if (
        expected !== undefined &&
        (await sha256(canonicalPath)) !== expected
      ) {
        diagnostics.push({
          stage,
          code: CODES.INPUT_TAMPERED,
          severity: "error",
          message: `${label} hash mismatch.`,
          path,
        });
      }
    } catch (error) {
      diagnostics.push({
        stage,
        code:
          error instanceof ArtifactInputError
            ? error.code
            : CODES.INPUT_MISSING,
        severity: "error",
        message: `${label}: ${error instanceof Error ? error.message : String(error)}`,
        path,
      });
    }
  }

  if (platform === "macos") {
    const plistPath = resolve(artifact.dir, "Contents/Info.plist");
    try {
      const canonicalPath = await inputPath(artifact.dir, plistPath);
      const metadata = bundleMetadata(await readFile(canonicalPath, "utf8"));
      if (process.platform === "darwin") {
        const validation = Bun.spawn(
          [
            "/usr/bin/plutil",
            "-lint",
            "--",
            canonicalPath,
          ],
          {
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        const [exit, stdout, stderr] = await Promise.all([
          validation.exited,
          new Response(validation.stdout).text(),
          new Response(validation.stderr).text(),
        ]);
        if (exit !== 0) {
          throw new Error(`Invalid Apple plist: ${(stdout + stderr).trim()}`);
        }
      }
      for (const [key, expected] of [
        [
          "CFBundleExecutable",
          basename(artifact.executable),
        ],
        [
          "CFBundleIdentifier",
          manifest.app.id,
        ],
        [
          "CFBundlePackageType",
          "APPL",
        ],
      ] as const) {
        if (plistString(metadata.get(key), "string") !== expected) {
          throw new Error(
            `Info.plist ${key} does not match the build artifact.`,
          );
        }
      }
      const bundleExecutable = await inputPath(
        artifact.dir,
        resolve(artifact.dir, "Contents/MacOS", basename(artifact.executable)),
      );
      if (
        bundleExecutable !==
        (await inputPath(artifact.dir, artifact.executable))
      ) {
        throw new Error(
          "Info.plist executable does not resolve to the build host.",
        );
      }
    } catch (error) {
      diagnostics.push({
        stage,
        code:
          error instanceof ArtifactInputError
            ? error.code
            : CODES.INPUT_TAMPERED,
        severity: "error",
        message: `Info.plist: ${error instanceof Error ? error.message : String(error)}`,
        path: plistPath,
      });
    }
  }

  // sourceSha256 predates macOS bundle signing and is provenance, not a final digest.
  const hostDigest = manifest.host?.packagedSha256 ?? manifest.host?.sha256;
  if (platform === "windows") {
    const host = manifest.host;
    if (
      host?.kind !== "bun-compiled" ||
      typeof host.executable !== "string" ||
      // biome-ignore lint/suspicious/noControlCharactersInRegex: Windows file-name restrictions.
      !/^[^<>:"/\\|?*\x00-\x1f]+\.exe$/i.test(host.executable)
    ) {
      diagnostics.push({
        stage,
        code: CODES.INPUT_UNEXPECTED,
        severity: "error",
        message:
          "Windows requires a compiled Bun app; run bunaway build again.",
        path: manifestPath,
      });
    } else {
      const executable = resolve(artifact.packageDir, host.executable);
      if (artifact.executable !== executable) {
        diagnostics.push({
          stage,
          code: CODES.INPUT_UNEXPECTED,
          severity: "error",
          message: "Windows executable does not match the build manifest.",
          path: artifact.executable,
        });
      }
      if (
        !isDigest(host.sha256) ||
        (host.packagedSha256 !== undefined && !isDigest(host.packagedSha256))
      ) {
        diagnostics.push({
          stage,
          code: CODES.INPUT_MISSING,
          severity: "error",
          message:
            "Windows build manifest has an invalid compiled executable hash.",
          path: manifestPath,
        });
      } else {
        await verifyFile(
          artifact.packageDir,
          executable,
          "Compiled app",
          hostDigest,
        );
      }
    }
  }
  if (!hostDigest && platform === "macos" && process.platform !== "darwin") {
    diagnostics.push({
      stage,
      code: CODES.INPUT_MISSING,
      severity: "error",
      message:
        "Build manifest has no final host executable hash; verify this signed bundle on macOS.",
      path: artifact.executable,
    });
  }
  if (platform === "macos") {
    await verifyFile(
      artifact.dir,
      artifact.executable,
      "Host executable",
      hostDigest,
      true,
    );
  }
  if (platform === "macos") {
    await verifyFile(
      artifact.packageDir,
      resolve(artifact.packageDir, "runtime/bun"),
      "Bundled Bun",
      packagedDigest(manifest.bun),
      true,
    );
  }

  const required = REQUIRED_ASSETS[platform];
  for (const path of required) {
    if (!Object.hasOwn(manifest.assets, path)) {
      diagnostics.push({
        stage,
        code: CODES.INPUT_MISSING,
        severity: "error",
        message: `Required build input is missing from the manifest: ${path}`,
        path: resolve(artifact.packageDir, path),
      });
    }
  }
  if (platform === "macos") {
    let homePath = resolve(artifact.packageDir, "assets/app.json");
    try {
      const appPath = await inputPath(artifact.packageDir, homePath);
      const app: unknown = JSON.parse(await readFile(appPath, "utf8"));
      const asset = homeAsset(isRecord(app) ? app.home : undefined);
      homePath = resolve(artifact.packageDir, asset);
      const web = resolve(artifact.packageDir, "assets/web");
      await inputPath(artifact.packageDir, web, true);
      await inputPath(web, homePath);
      if (!Object.hasOwn(manifest.assets, asset)) {
        throw new ArtifactInputError(
          CODES.INPUT_MISSING,
          `Home document is missing from the manifest: ${asset}`,
        );
      }
    } catch (error) {
      diagnostics.push({
        stage,
        code:
          error instanceof ArtifactInputError
            ? error.code
            : CODES.INPUT_MISSING,
        severity: "error",
        message: error instanceof Error ? error.message : String(error),
        path: homePath,
      });
    }
  }
  for (const [relative, expected] of Object.entries(manifest.assets)) {
    const path = resolve(artifact.packageDir, relative);
    await verifyFile(
      artifact.packageDir,
      path,
      `Manifest asset ${relative}`,
      expected,
    );
  }
  if (platform === "macos" && !hostDigest && diagnostics.length === 0) {
    try {
      const validation = Bun.spawn(
        [
          "/usr/bin/codesign",
          "--verify",
          "--deep",
          "--strict",
          artifact.dir,
        ],
        {
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [exit, stdout, stderr] = await Promise.all([
        validation.exited,
        new Response(validation.stdout).text(),
        new Response(validation.stderr).text(),
      ]);
      if (exit !== 0) {
        throw new Error(`Invalid code signature: ${(stdout + stderr).trim()}`);
      }
    } catch (error) {
      diagnostics.push({
        stage,
        code: CODES.INPUT_TAMPERED,
        severity: "error",
        message: `macOS bundle integrity: ${error instanceof Error ? error.message : String(error)}`,
        path: artifact.dir,
      });
    }
  }
  return diagnostics;
}
