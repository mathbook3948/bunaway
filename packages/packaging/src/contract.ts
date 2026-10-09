// Shared packaging contract between the CLI entry point and channel adapters.
//
// build vs package: `bunaway build` produces a channel-neutral artifact
// (dist/<target>) that this contract consumes read-only. `bunaway package
// <channel>` runs one adapter, which must never mutate the build artifact —
// everything lands in a runner-owned staging directory that is moved into
// place atomically, so a failed package run preserves the previous output.
//
// Hash rule: signing changes executable bytes, so every packaged executable
// keeps two digests in manifest.json — `sourceSha256` (the upstream artifact,
// pinned and immutable) and `packagedSha256` (the final bytes shipped inside
// the package, recomputed after any signing step). Runtime integrity checks
// prefer `packagedSha256` and fall back to the upstream digest when the file
// was never re-signed. Unsigned outputs still record `packagedSha256` equal to
// `sourceSha256` so the rule is uniform across channels.
//
// Diagnostics are structured: every stage reports {stage, code, severity,
// message, path?} entries into the packaging report instead of only throwing.
// Codes are stable (`PKG_*`) so tests, CI and sibling adapters can rely on
// them. An unsigned distribution artifact is never reported as store-submittable.

export const PACKAGING_CHANNELS = [
  "win-direct",
  "win-store-msix",
  "win-store-unpackaged",
  "mac-direct",
  "mac-store",
] as const;
export type ChannelId = (typeof PACKAGING_CHANNELS)[number];

export const PLATFORMS = [
  "windows",
  "macos",
] as const;
export type PlatformId = (typeof PLATFORMS)[number];

export const BUILD_TARGETS = [
  "windows-x64",
  "macos-arm64",
] as const;
export type BuildTarget = (typeof BUILD_TARGETS)[number];

export function isChannelId(value: string): value is ChannelId {
  return (PACKAGING_CHANNELS as readonly string[]).includes(value);
}

export function platformOf(channel: ChannelId): PlatformId {
  return channel.startsWith("win-") ? "windows" : "macos";
}

/**
 * Resolves the supported build target for a platform and architecture.
 * Throws when the combination has no build artifact.
 */
export function targetFor(platform: PlatformId, arch: string): BuildTarget {
  if (platform === "windows" && arch === "x64") {
    return "windows-x64";
  }
  if (platform === "macos" && arch === "arm64") {
    return "macos-arm64";
  }
  throw new Error(`No build target for ${platform}-${arch}.`);
}

export type DiagnosticSeverity = "info" | "warning" | "error";

export interface Diagnostic {
  stage: string;
  code: string;
  severity: DiagnosticSeverity;
  message: string;
  path?: string;
}

// Stable diagnostic codes emitted by the shared runner. Adapters should reuse
// these before inventing channel-specific ones.
export const CODES = {
  CONFIG_INVALID: "PKG_CONFIG_INVALID",
  CHANNEL_UNKNOWN: "PKG_CHANNEL_UNKNOWN",
  CHANNEL_NOT_CONFIGURED: "PKG_CHANNEL_NOT_CONFIGURED",
  TARGET_MISSING: "PKG_TARGET_MISSING",
  INPUT_MISSING: "PKG_INPUT_MISSING",
  INPUT_TAMPERED: "PKG_INPUT_TAMPERED",
  INPUT_UNEXPECTED: "PKG_INPUT_UNEXPECTED",
  ADAPTER_MISSING: "PKG_ADAPTER_MISSING",
  TOOL_MISSING: "PKG_TOOL_MISSING",
  TOOL_FAILED: "PKG_TOOL_FAILED",
  SIGNING_MISSING: "PKG_SIGNING_MISSING",
  SIGNING_FAILED: "PKG_SIGNING_FAILED",
  STAGE_FAILED: "PKG_STAGE_FAILED",
  LOCK_FAILED: "PKG_LOCK_FAILED",
  VERIFY_FAILED: "PKG_VERIFY_FAILED",
} as const;

// Resolved, channel-independent metadata derived from bunaway.json.bundle,
// app.json and package.json. This is the single source adapters read — they
// must not re-derive identity fields.
export interface ResolvedPackaging {
  root: string;
  name: string;
  identifier: string;
  publisher: {
    display: string;
    // X.500 subject ("CN=..."), required by MSIX manifests and used to check
    // the signing certificate identity.
    identity?: string;
  };
  version: {
    semver: string;
    build: number;
    // Four-part version required by MSIX manifests.
    msix: string;
  };
  // Declared icon assets resolved to absolute paths that are verified to be
  // regular files. Keys are contract names (e.g. "windows.square150").
  icons: Record<string, string>;
  targets: ResolvedTarget[];
}

export interface ResolvedTarget {
  platform: PlatformId;
  arch: "x64" | "arm64";
  minVersion?: string;
}

// Developer-provided signing configuration. Values reference credentials —
// never contain secrets. `passwordEnv` names an environment variable read at
// sign time only.
export interface SigningConfig {
  certificateFile?: string;
  thumbprint?: string;
  subject?: string;
  timestampUrl?: string;
  passwordEnv?: string;
}

export interface ChannelConfig {
  scope?: "perUser" | "perMachine";
  webView2?: "check" | "bootstrap";
  desktopShortcut?: boolean;
  startMenuShortcut?: boolean;
  uninstall?: {
    preserveUserData?: boolean;
  };
  packageName?: string;
  unvirtualizedData?: boolean;
  minVersion?: string;
  maxVersionTested?: string;
  capabilities?: string[];
  format?: string;
  bundleId?: string;
  entitlements?: string[];
  signing?: SigningConfig;
}

// Everything an adapter is allowed to consume. Build outputs arrive as
// already-validated structures; adapters do not re-parse project sources.
export interface AdapterInput {
  channel: ChannelId;
  channelConfig: ChannelConfig;
  metadata: ResolvedPackaging;
  target: BuildTarget;
  artifact: BuildArtifact;
  manifest: PackageManifest;
  // Developer-provided signing configuration effective for this channel
  // (channel-level value, or the top-level default when the channel has none).
  signing?: SigningConfig;
}

export interface BuildArtifact {
  // Root of the channel-neutral build output (dist/<target> for Windows,
  // dist/<target>/<appId>.app for macOS).
  dir: string;
  // Directory containing manifest.json, assets/, licenses/, runtime/.
  packageDir: string;
  // Host executable inside the artifact.
  executable: string;
}

// The manifest.json the build writes next to assets/. Only the fields the
// contract relies on are typed; extra keys are preserved for passthrough.
export interface PackageManifest {
  bun: {
    version: string;
    target: string;
    executableSha256: string;
    licenseSha256: string;
    sourceRevision: string;
    // Written by adapters that re-sign bun inside the package.
    packagedSha256?: string;
    [key: string]: unknown;
  };
  assets: Record<string, string>;
  app: {
    id: string;
    version: string;
  };
  framework?: {
    version: string;
  };
  host?: {
    target: string;
    kind?: string;
    executable?: string;
    sha256?: string;
    sourceSha256?: string;
    packagedSha256?: string;
  };
  [key: string]: unknown;
}

/**
 * Returns the digest of the bytes that should be checked at runtime.
 * Packaged bytes take precedence after signing; legacy host entries keep their
 * `sha256` and `sourceSha256` fallbacks.
 */
export function packagedDigest(entry: {
  executableSha256?: string;
  sourceSha256?: string;
  sha256?: string;
  packagedSha256?: string;
}): string | undefined {
  if ("executableSha256" in entry) {
    return entry.packagedSha256 ?? entry.executableSha256;
  }
  return entry.packagedSha256 ?? entry.sha256 ?? entry.sourceSha256;
}

// How much weight a channel puts on signing:
// - "optional": unsigned artifacts still run locally (e.g. Inno installer with
//   a SmartScreen warning).
// - "required-to-run": the artifact cannot be installed/run at all unsigned
//   (MSIX refuses unsigned packages).
// - "required-to-submit": unsigned runs locally but the store rejects it
//   (Store EXE/MSI requires a Trusted Root chain).
export type SigningRequirement =
  | "optional"
  | "required-to-run"
  | "required-to-submit";

/**
 * Channel-specific packaging behavior. Stages run in order after the shared
 * runner validates inputs; `stages` may reject configuration before adapter
 * stages run.
 */
export interface PackageAdapter {
  readonly channel: ChannelId;
  readonly platform: PlatformId;
  readonly signingRequirement: SigningRequirement;
  // Ordered stages the runner executes. Called after inputs are validated;
  // throw for configuration errors before any filesystem work happens.
  stages(input: AdapterInput): AdapterStage[];
}

export interface AdapterStage {
  id: string;
  title: string;
  run(ctx: StageContext): Promise<void>;
}

/**
 * Resources and reporting hooks supplied to one adapter stage. The runner
 * owns the staging directory and publishes it only after stages and output
 * checks succeed.
 */
export interface StageContext {
  input: AdapterInput;
  // Runner-owned staging directory. Everything the package needs goes here —
  // it is renamed into the output directory only after all stages succeed.
  // Links must be relative and resolve inside staging; absolute links/junctions
  // would break when staging is renamed and are rejected before publication.
  staging: string;
  // Report a structured diagnostic for the current stage.
  report(diagnostic: Omit<Diagnostic, "stage">): void;
  // Register a produced artifact (installers, msix, submission bundles) so the
  // runner can hash/size it and list it in the report. Paths must resolve inside staging.
  // Only non-distributable sidecars (e.g. checksums) may opt out of signing.
  addArtifact(
    path: string,
    kind: string,
    options?: {
      signed?: boolean;
      signingRequired?: boolean;
    },
  ): void;
}

export interface ProducedArtifact {
  path: string;
  kind: string;
  signed: boolean;
  signingRequired: boolean;
}

export type StageStatus = "ok" | "failed" | "skipped";

export interface StageResult {
  id: string;
  title: string;
  status: StageStatus;
  durationMs: number;
}

/**
 * Result of a packaging run. `ok` reports pipeline success; `usable` also
 * applies the channel's run-signing rule; `submittable` requires a successful
 * run, at least one distributable artifact, and signatures on all of them.
 */
export interface PackageReport {
  channel: ChannelId;
  target: BuildTarget;
  app: {
    id: string;
    name: string;
    identifier: string;
    version: string;
  };
  startedAt: string;
  ok: boolean;
  usable: boolean;
  submittable: boolean;
  signing: {
    requirement: SigningRequirement;
    configured: boolean;
    performed: boolean;
    detail?: string;
  };
  stages: StageResult[];
  diagnostics: Diagnostic[];
  artifacts: (ProducedArtifact & {
    sha256: string;
    size: number;
  })[];
  // Free-form notes for verified vs unverified scope (e.g. "locally sideloaded
  // only; store signing not performed").
  notes: string[];
}
