import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, readFile, realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep, win32 } from "node:path";
import { isRecord, isWindowsExecutableName } from "@bunaway/protocol";
import { XMLParser } from "fast-xml-parser";
import {
  type BuildArtifact,
  type BuildTarget,
  type ChannelId,
  CODES,
  type Diagnostic,
  type PackageManifest,
  platformOf,
} from "./contract.ts";
import { outputPaths } from "./paths.ts";

/**
 * Computes paths for the channel-neutral artifact produced by `bunaway build`.
 * Windows uses `dist/windows-x64`; macOS uses the app bundle's
 * `Contents/Resources` as its package root. Adapters must treat it as read-only.
 */
export function artifactPaths(args: {
  root: string;
  target: BuildTarget;
  appId: string;
  executableName?: string;
}): BuildArtifact {
  const { root, target, appId } = args;
  if (target === "windows-x64") {
    const dir = outputPaths(root, target).output;
    return {
      dir,
      packageDir: dir,
      executable: resolve(dir, args.executableName ?? `${appId}.exe`),
    };
  }
  const dir = resolve(outputPaths(root, target).output, `${appId}.app`);
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
  // A lexical path can escape through a symlink, so check its real target too.
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
  if (!isPlistScalar(tag, text)) {
    throw new Error(`Invalid plist ${tag} value.`);
  }
}

/** Check a scalar plist value's text against its tag's lexical form. */
function isPlistScalar(tag: string, text: string): boolean {
  const value = text.trim();
  switch (tag) {
    case "integer":
      return /^[+-]?(?:0[xX][0-9a-fA-F]+|[0-9]+)$/.test(value);
    case "real":
      return /^[+-]?(?:(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?|inf(?:inity)?|nan)$/i.test(
        value,
      );
    case "date":
      return (
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value) &&
        Number.isFinite(Date.parse(value))
      );
    default:
      // data: base64 text, whitespace allowed between groups.
      return /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        text.replace(/\s/g, ""),
      );
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

/** Validates manifest structure and asset paths before file checks. */
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
    "assets/manifest.json",
    "assets/boot.js",
    "licenses/LICENSE.bun",
  ],
};

/** Resolves a host-owned home URL to its path under the packaged web assets. */
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

/**
 * Reads and validates the build manifest before adapters receive it.
 * Throws when the manifest is missing, malformed, or outside the artifact root.
 */
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

const VERIFY_STAGE = "verify";

function verifyError(code: Diagnostic["code"], message: string, path: string) {
  return {
    stage: VERIFY_STAGE,
    code,
    severity: "error",
    message,
    path,
  } as const satisfies Diagnostic;
}

/** The input-error code, or the fallback for errors that are not artifact input errors. */
function inputErrorCode(error: unknown, fallback: Diagnostic["code"]) {
  return error instanceof ArtifactInputError ? error.code : fallback;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Run a tool and return its exit code and combined, trimmed output. */
async function captureCommand(args: string[]): Promise<{
  exit: number;
  output: string;
}> {
  const child = Bun.spawn(args, {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return {
    exit,
    output: (stdout + stderr).trim(),
  };
}

/** Check one file against its recorded digest, and its execute permission where POSIX applies. */
async function verifyFile(
  diagnostics: Diagnostic[],
  root: string,
  path: string,
  label: string,
  expected?: string,
  executable = false,
): Promise<void> {
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
    if (expected !== undefined && (await sha256(canonicalPath)) !== expected) {
      diagnostics.push(
        verifyError(CODES.INPUT_TAMPERED, `${label} hash mismatch.`, path),
      );
    }
  } catch (error) {
    diagnostics.push(
      verifyError(
        inputErrorCode(error, CODES.INPUT_MISSING),
        `${label}: ${errorMessage(error)}`,
        path,
      ),
    );
  }
}

/** The macOS bundle's Info.plist must be valid and describe the build host. */
async function verifyBundlePlist(
  diagnostics: Diagnostic[],
  artifact: BuildArtifact,
  manifest: PackageManifest,
): Promise<void> {
  const plistPath = resolve(artifact.dir, "Contents/Info.plist");
  try {
    const canonicalPath = await inputPath(artifact.dir, plistPath);
    const metadata = bundleMetadata(await readFile(canonicalPath, "utf8"));
    if (process.platform === "darwin") {
      const lint = await captureCommand([
        "/usr/bin/plutil",
        "-lint",
        "--",
        canonicalPath,
      ]);
      if (lint.exit !== 0) {
        throw new Error(`Invalid Apple plist: ${lint.output}`);
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
        throw new Error(`Info.plist ${key} does not match the build artifact.`);
      }
    }
    const bundleExecutable = await inputPath(
      artifact.dir,
      resolve(artifact.dir, "Contents/MacOS", basename(artifact.executable)),
    );
    if (
      bundleExecutable !== (await inputPath(artifact.dir, artifact.executable))
    ) {
      throw new Error(
        "Info.plist executable does not resolve to the build host.",
      );
    }
  } catch (error) {
    diagnostics.push(
      verifyError(
        inputErrorCode(error, CODES.INPUT_TAMPERED),
        `Info.plist: ${errorMessage(error)}`,
        plistPath,
      ),
    );
  }
}

/** Windows packages carry a compiled Bun executable whose name and digests match the manifest. */
async function verifyWindowsHost(
  diagnostics: Diagnostic[],
  artifact: BuildArtifact,
  manifest: PackageManifest,
  manifestPath: string,
  hostDigest: string | undefined,
): Promise<void> {
  const host = manifest.host;
  if (host?.kind !== "bun-compiled" || typeof host.executable !== "string") {
    diagnostics.push(
      verifyError(
        CODES.INPUT_UNEXPECTED,
        "Windows requires a compiled Bun app.",
        manifestPath,
      ),
    );
    return;
  }
  if (!isWindowsExecutableName(host.executable)) {
    diagnostics.push(
      verifyError(
        CODES.INPUT_UNEXPECTED,
        `Windows cannot create an executable named "${host.executable}"; use a valid .exe file name.`,
        manifestPath,
      ),
    );
    return;
  }
  const executable = resolve(artifact.packageDir, host.executable);
  if (artifact.executable !== executable) {
    diagnostics.push(
      verifyError(
        CODES.INPUT_UNEXPECTED,
        "Windows executable does not match the build manifest.",
        artifact.executable,
      ),
    );
  }
  if (
    !isDigest(host.sha256) ||
    (host.packagedSha256 !== undefined && !isDigest(host.packagedSha256))
  ) {
    diagnostics.push(
      verifyError(
        CODES.INPUT_MISSING,
        "Windows build manifest has an invalid compiled executable hash.",
        manifestPath,
      ),
    );
  } else {
    await verifyFile(
      diagnostics,
      artifact.packageDir,
      executable,
      "Compiled app",
      hostDigest,
    );
  }
}

/** macOS packages carry a compiled, executable host; its final digest is only checkable on macOS. */
async function verifyMacosHost(
  diagnostics: Diagnostic[],
  artifact: BuildArtifact,
  manifest: PackageManifest,
  manifestPath: string,
  hostDigest: string | undefined,
): Promise<void> {
  if (!hostDigest && process.platform !== "darwin") {
    diagnostics.push(
      verifyError(
        CODES.INPUT_MISSING,
        "Build manifest has no final host executable hash; verify this signed bundle on macOS.",
        artifact.executable,
      ),
    );
  }
  if (manifest.host?.kind !== "bun-compiled") {
    diagnostics.push(
      verifyError(
        CODES.INPUT_UNEXPECTED,
        "macOS requires a compiled Bun app.",
        manifestPath,
      ),
    );
  }
  await verifyFile(
    diagnostics,
    artifact.dir,
    artifact.executable,
    "Host executable",
    hostDigest,
    true,
  );
}

/** The macOS home document must be a web asset listed in the manifest. */
async function verifyMacosHome(
  diagnostics: Diagnostic[],
  artifact: BuildArtifact,
  manifest: PackageManifest,
): Promise<void> {
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
    diagnostics.push(
      verifyError(
        inputErrorCode(error, CODES.INPUT_MISSING),
        errorMessage(error),
        homePath,
      ),
    );
  }
}

/** An unsigned-digest macOS bundle is verified through its code signature instead. */
async function verifyMacosSignature(
  diagnostics: Diagnostic[],
  artifact: BuildArtifact,
): Promise<void> {
  try {
    const verification = await captureCommand([
      "/usr/bin/codesign",
      "--verify",
      "--deep",
      "--strict",
      artifact.dir,
    ]);
    if (verification.exit !== 0) {
      throw new Error(`Invalid code signature: ${verification.output}`);
    }
  } catch (error) {
    diagnostics.push(
      verifyError(
        CODES.INPUT_TAMPERED,
        `macOS bundle integrity: ${errorMessage(error)}`,
        artifact.dir,
      ),
    );
  }
}

/**
 * Checks artifact paths, required inputs, metadata and recorded digests before
 * an adapter can stage files. Failures are returned as diagnostics, with
 * missing inputs distinguished from hash or path tampering.
 */
export async function verifyArtifact(args: {
  artifact: BuildArtifact;
  manifest: PackageManifest;
  channel: ChannelId;
}): Promise<Diagnostic[]> {
  const { artifact, manifest, channel } = args;
  const diagnostics: Diagnostic[] = [];
  const platform = platformOf(channel);
  const manifestPath = resolve(artifact.packageDir, "manifest.json");
  try {
    await inputPath(artifact.dir, artifact.packageDir, true);
    await inputPath(artifact.packageDir, manifestPath);
    validateManifest(manifest);
  } catch (error) {
    diagnostics.push(
      verifyError(
        inputErrorCode(error, CODES.INPUT_MISSING),
        errorMessage(error),
        manifestPath,
      ),
    );
    return diagnostics;
  }
  if (platform === "macos") {
    await verifyBundlePlist(diagnostics, artifact, manifest);
  }
  // sourceSha256 predates macOS bundle signing and is provenance, not a final digest.
  const hostDigest = manifest.host?.packagedSha256 ?? manifest.host?.sha256;
  if (platform === "windows") {
    await verifyWindowsHost(
      diagnostics,
      artifact,
      manifest,
      manifestPath,
      hostDigest,
    );
  }
  if (platform === "macos") {
    await verifyMacosHost(
      diagnostics,
      artifact,
      manifest,
      manifestPath,
      hostDigest,
    );
  }
  for (const path of REQUIRED_ASSETS[platform]) {
    if (!Object.hasOwn(manifest.assets, path)) {
      diagnostics.push(
        verifyError(
          CODES.INPUT_MISSING,
          `Required build input is missing from the manifest: ${path}`,
          resolve(artifact.packageDir, path),
        ),
      );
    }
  }
  if (platform === "macos") {
    await verifyMacosHome(diagnostics, artifact, manifest);
  }
  for (const [relative, expected] of Object.entries(manifest.assets)) {
    await verifyFile(
      diagnostics,
      artifact.packageDir,
      resolve(artifact.packageDir, relative),
      `Manifest asset ${relative}`,
      expected,
    );
  }
  if (platform === "macos" && !hostDigest && diagnostics.length === 0) {
    await verifyMacosSignature(diagnostics, artifact);
  }
  return diagnostics;
}
