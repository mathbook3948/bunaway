import { createHash } from "node:crypto";
import {
  type FileHandle,
  lstat,
  open,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  type AdapterInput,
  BUILD_TARGETS,
  type BuildArtifact,
  type BuildTarget,
  type ChannelConfig,
  type ChannelId,
  CODES,
  type Diagnostic,
  isChannelId,
  type PackageAdapter,
  type PackageManifest,
  type PackageReport,
  type ProducedArtifact,
  platformOf,
  type ResolvedPackaging,
  type SigningConfig,
  type StageContext,
  type StageResult,
} from "./contract.ts";
import { ownedDirectory } from "./directories.ts";
import { ArtifactInputError, loadManifest, verifyArtifact } from "./inputs.ts";
import { acquirePackageInputLock, TargetLockError } from "./locks.ts";
import { outputPaths } from "./paths.ts";

export interface RunPackageArgs {
  metadata: ResolvedPackaging;
  appId: string;
  channel: ChannelId;
  channelConfig: ChannelConfig;
  signing?: SigningConfig;
  target: BuildTarget;
  artifact: BuildArtifact;
  adapter: PackageAdapter;
  // Extra notes recorded in the report (e.g. built during this run).
  notes?: string[];
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

/** Returns the shared packaging output root for one build target. */
export function packagingOutputDir(root: string, target: BuildTarget): string {
  return outputPaths(root, target).packaged;
}

/** Returns the report path paired with a target's packaged outputs. */
export function packagingReportPath(
  root: string,
  target: BuildTarget,
  channel: ChannelId,
): string {
  return resolve(packagingOutputDir(root, target), `${channel}-report.json`);
}

/** Explain why the packaging lock could not be taken without leaking the lock path's cause chain. */
function describeLockFailure(error: unknown, channel: ChannelId): string {
  if (error instanceof TargetLockError) {
    return error.message;
  }
  if ((error as NodeJS.ErrnoException).code === "EEXIST") {
    return `Packaging channel ${channel} is locked; another run may be active.`;
  }
  return `Cannot acquire package lock: ${error instanceof Error ? error.message : String(error)}`;
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** A symlink must be relative and every step of its target must stay inside the canonical staging root. */
async function verifyStagingLink(
  path: string,
  canonicalStaging: string,
): Promise<void> {
  // Absolute targets still point at the old staging path after publication.
  const link = await readlink(path);
  if (isAbsolute(link)) {
    throw new Error(
      `Absolute staging links cannot survive publication: ${path}`,
    );
  }
  let target = dirname(path);
  // A relative link can leave and reenter through the staging name, then break on rename.
  for (const part of link.split(
    process.platform === "win32" ? /[\\/]/ : /\//,
  )) {
    target = await realpath(`${target}${sep}${part}`);
    if (!inside(canonicalStaging, target)) {
      throw new Error(`Staging link escapes staging: ${path}`);
    }
  }
}

/** Rejects absolute or escaping links before publishing staging. */
async function verifyStagingLinks(staging: string): Promise<void> {
  if (!(await lstat(staging)).isDirectory()) {
    throw new Error("Staging root is not a regular directory.");
  }
  const canonicalStaging = await realpath(staging);
  const directories = [
    staging,
  ];
  for (const directory of directories) {
    for (const entry of await readdir(directory, {
      withFileTypes: true,
    })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        directories.push(path);
      } else if (entry.isSymbolicLink()) {
        await verifyStagingLink(path, canonicalStaging);
      }
    }
  }
}

const EMPTY_MANIFEST: PackageManifest = {
  bun: {
    version: "",
    sourceRevision: "",
    target: "",
    executableSha256: "",
    licenseSha256: "",
  },
  assets: {},
  app: {
    id: "",
    version: "",
  },
};

/** State one packaging run shares between its ordered stages. */
interface PackageRun {
  args: RunPackageArgs;
  input: AdapterInput;
  report: PackageReport;
  diagnostics: Diagnostic[];
  stages: StageResult[];
  produced: ProducedArtifact[];
  verified: PackageReport["artifacts"];
  notes: string[];
  output: string;
  staging: string;
  reportPath: string;
  stagedReport: string;
  lockPath: string;
  invalidName: boolean;
  failed: boolean;
  reportPublished: boolean;
}

type AdapterStage = ReturnType<PackageAdapter["stages"]>[number];

/** The held package lock file and the target input lock, released in reverse order of acquisition. */
interface RunLocks {
  lock: FileHandle;
  releaseTarget: () => Promise<void>;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createPackageRun(args: RunPackageArgs): PackageRun {
  const {
    metadata,
    appId,
    channel,
    channelConfig,
    signing,
    target,
    artifact,
    adapter,
  } = args;
  const diagnostics: Diagnostic[] = [];
  const stages: StageResult[] = [];
  const notes: string[] = [
    ...(args.notes ?? []),
  ];
  const output = resolve(packagingOutputDir(metadata.root, target), channel);
  const paths = outputPaths(metadata.root, target);
  const platform = platformOf(channel);
  const invalidName = !isChannelId(channel) || !BUILD_TARGETS.includes(target);
  if (
    invalidName ||
    adapter.channel !== channel ||
    adapter.platform !== platform ||
    !target.startsWith(`${platform}-`)
  ) {
    diagnostics.push({
      stage: "resolve",
      code: CODES.CONFIG_INVALID,
      severity: "error",
      message: `Channel ${channel} (${platform}), adapter ${adapter.channel} (${adapter.platform}) and target ${target} must use the same channel and platform.`,
    });
  }
  const reportPath = packagingReportPath(metadata.root, target, channel);
  return {
    args,
    input: {
      channel,
      channelConfig,
      metadata,
      target,
      artifact,
      manifest: EMPTY_MANIFEST,
      ...(signing
        ? {
            signing,
          }
        : {}),
    },
    report: {
      channel,
      target,
      app: {
        id: appId,
        name: metadata.name,
        identifier: metadata.identifier,
        version: metadata.version.semver,
      },
      startedAt: new Date().toISOString(),
      ok: false,
      usable: false,
      submittable: false,
      signing: {
        requirement: adapter.signingRequirement,
        configured: signing !== undefined,
        performed: false,
      },
      stages,
      diagnostics,
      artifacts: [],
      notes,
    },
    diagnostics,
    stages,
    produced: [],
    verified: [],
    notes,
    output,
    staging: resolve(
      paths.work,
      `${basename(output)}.building-${crypto.randomUUID()}`,
    ),
    reportPath,
    stagedReport: `${reportPath}.building-${crypto.randomUUID()}`,
    lockPath: resolve(paths.locks, `${channel}.lock`),
    invalidName,
    failed: diagnostics.length > 0,
    reportPublished: false,
  };
}

function reportFailure(run: PackageRun, error: unknown): void {
  const { report } = run;
  report.ok = false;
  report.usable = false;
  report.submittable = false;
  report.signing.performed = false;
  report.artifacts = [];
  run.diagnostics.push({
    stage: "report",
    code: CODES.STAGE_FAILED,
    severity: "error",
    message: errorText(error),
  });
}

async function removeOwned(
  run: PackageRun,
  path: string,
  recursive = false,
): Promise<void> {
  if (await ownedDirectory(run.args.metadata.root, dirname(path))) {
    // rm unlinks a leaf symlink/junction; only its parent must be owned.
    await rm(path, {
      recursive,
      force: true,
    });
  }
}

async function stageReport(run: PackageRun): Promise<void> {
  await removeOwned(run, run.stagedReport);
  await writeFile(
    run.stagedReport,
    `${JSON.stringify(run.report, null, 2)}\n`,
    {
      flag: "wx",
    },
  );
}

async function writeReport(run: PackageRun): Promise<void> {
  await stageReport(run);
  await rename(run.stagedReport, run.reportPath);
}

/** Take the target input lock and the channel lock file; on failure record why and release what was taken. */
async function acquireRunLocks(run: PackageRun): Promise<RunLocks | undefined> {
  const { metadata, channel, target } = run.args;
  let releaseTarget: (() => Promise<void>) | undefined;
  try {
    releaseTarget = await acquirePackageInputLock(metadata.root, target);
    await ownedDirectory(metadata.root, dirname(run.output), true);
    return {
      lock: await open(run.lockPath, "wx"),
      releaseTarget,
    };
  } catch (error) {
    await releaseTarget?.();
    run.diagnostics.push({
      stage: "resolve",
      code: CODES.LOCK_FAILED,
      severity: "error",
      message: describeLockFailure(error, channel),
      path: error instanceof TargetLockError ? error.path : run.lockPath,
    });
    return undefined;
  }
}

async function loadInputManifest(run: PackageRun): Promise<void> {
  const { artifact } = run.args;
  try {
    run.input.manifest = await loadManifest(artifact);
  } catch (error) {
    run.diagnostics.push({
      stage: "resolve",
      code:
        error instanceof ArtifactInputError ? error.code : CODES.INPUT_MISSING,
      severity: "error",
      message: errorText(error),
      path: resolve(artifact.packageDir, "manifest.json"),
    });
    run.failed = true;
  }
}

/** Verify the build artifact's inputs, and that it belongs to the app being packaged. */
async function verifyInputs(run: PackageRun): Promise<void> {
  const { artifact, channel, appId } = run.args;
  const { manifest } = run.input;
  const started = Date.now();
  const integrity = await verifyArtifact({
    artifact,
    manifest,
    channel,
  });
  if (manifest.app.id !== appId) {
    integrity.push({
      stage: "verify",
      code: CODES.INPUT_UNEXPECTED,
      severity: "error",
      message: `Build artifact belongs to app ${manifest.app.id}, not ${appId}; run bunaway build again.`,
      path: resolve(artifact.packageDir, "manifest.json"),
    });
  }
  run.diagnostics.push(...integrity);
  run.failed = integrity.some((d) => d.severity === "error");
  run.stages.push({
    id: "verify",
    title: "Verify build artifact inputs",
    status: run.failed ? "failed" : "ok",
    durationMs: Date.now() - started,
  });
}

function planAdapterStages(run: PackageRun): AdapterStage[] {
  try {
    return run.args.adapter.stages(run.input);
  } catch (error) {
    run.diagnostics.push({
      stage: "resolve",
      code: CODES.CONFIG_INVALID,
      severity: "error",
      message: errorText(error),
    });
    run.failed = true;
    return [];
  }
}

function hasStageError(run: PackageRun, stageId: string): boolean {
  return run.diagnostics.some(
    (d) => d.severity === "error" && d.stage === stageId,
  );
}

/** Run one adapter stage in staging, recording its diagnostics, artifacts and result. */
async function runAdapterStage(
  run: PackageRun,
  stage: AdapterStage,
): Promise<void> {
  const started = Date.now();
  const ctx: StageContext = {
    input: run.input,
    staging: run.staging,
    report(diagnostic) {
      run.diagnostics.push({
        stage: stage.id,
        ...diagnostic,
      });
    },
    addArtifact(path, kind, options) {
      run.produced.push({
        path,
        kind,
        signed: options?.signed ?? false,
        signingRequired: options?.signingRequired ?? true,
      });
    },
  };
  try {
    await ownedDirectory(run.args.metadata.root, run.staging, true);
    await stage.run(ctx);
    run.stages.push({
      id: stage.id,
      title: stage.title,
      status: hasStageError(run, stage.id) ? "failed" : "ok",
      durationMs: Date.now() - started,
    });
  } catch (error) {
    run.diagnostics.push({
      stage: stage.id,
      code: CODES.STAGE_FAILED,
      severity: "error",
      message: errorText(error),
    });
    run.stages.push({
      id: stage.id,
      title: stage.title,
      status: "failed",
      durationMs: Date.now() - started,
    });
  }
  if (hasStageError(run, stage.id)) {
    run.failed = true;
  }
}

async function runAdapterStages(
  run: PackageRun,
  adapterStages: AdapterStage[],
): Promise<void> {
  for (const stage of adapterStages) {
    if (run.failed) {
      run.stages.push({
        id: stage.id,
        title: stage.title,
        status: "skipped",
        durationMs: 0,
      });
    } else {
      await runAdapterStage(run, stage);
    }
  }
}

/** Check that one declared artifact is a regular file that stays inside staging, and record its digest. */
async function verifyProducedArtifact(
  run: PackageRun,
  entry: ProducedArtifact,
): Promise<boolean> {
  const { staging } = run;
  let path = entry.path;
  try {
    if (
      entry.path
        .split(process.platform === "win32" ? /[\\/]/ : /\//)
        .includes("..")
    ) {
      throw new Error("Artifact path contains ambiguous parent components.");
    }
    path = isAbsolute(entry.path) ? entry.path : resolve(staging, entry.path);
    if (!(await lstat(staging)).isDirectory()) {
      throw new Error("Staging root is not a regular directory.");
    }
    if (!inside(staging, path)) {
      throw new Error("Artifact path escapes staging.");
    }
    if (!(await lstat(path)).isFile()) {
      throw new Error("Artifact is not a regular file.");
    }
    const canonicalStaging = await realpath(staging);
    const canonicalPath = await realpath(path);
    if (!inside(canonicalStaging, canonicalPath)) {
      throw new Error("Artifact real path escapes staging.");
    }
    const file = await lstat(canonicalPath);
    if (!file.isFile()) {
      throw new Error("Artifact is not a regular file.");
    }
    run.verified.push({
      path: resolve(staging, relative(canonicalStaging, canonicalPath)),
      kind: entry.kind,
      signed: entry.signed,
      signingRequired: entry.signingRequired,
      sha256: await sha256(canonicalPath),
      size: file.size,
    });
    return true;
  } catch (error) {
    run.diagnostics.push({
      stage: "verify-artifact",
      code: CODES.VERIFY_FAILED,
      severity: "error",
      message: `Cannot verify declared artifact ${entry.path}: ${errorText(error)}`,
      path,
    });
    return false;
  }
}

/** Verify the produced artifacts and staging links; a failed run records the stage as skipped. */
async function verifyProducedArtifacts(run: PackageRun): Promise<void> {
  if (run.failed) {
    run.stages.push({
      id: "verify-artifact",
      title: "Verify produced artifacts",
      status: "skipped",
      durationMs: 0,
    });
    return;
  }
  const started = Date.now();
  const { staging } = run;
  // Work and output have separate parents; validate work again after adapter code.
  await ownedDirectory(run.args.metadata.root, dirname(staging));
  if (run.produced.length === 0) {
    run.diagnostics.push({
      stage: "verify-artifact",
      code: CODES.VERIFY_FAILED,
      severity: "error",
      message: "The adapter produced no artifacts.",
    });
    run.failed = true;
  }
  if (!run.failed) {
    try {
      await verifyStagingLinks(staging);
    } catch (error) {
      run.diagnostics.push({
        stage: "verify-artifact",
        code: CODES.VERIFY_FAILED,
        severity: "error",
        message: errorText(error),
        path: staging,
      });
      run.failed = true;
    }
  }
  for (const entry of run.produced) {
    if (!(await verifyProducedArtifact(run, entry))) {
      run.failed = true;
    }
  }
  run.stages.push({
    id: "verify-artifact",
    title: "Verify produced artifacts",
    status: run.failed ? "failed" : "ok",
    durationMs: Date.now() - started,
  });
}

/** Decide the report's signing and success flags from the verified artifacts. */
function finalizeReport(run: PackageRun): void {
  const { report, verified, diagnostics, notes } = run;
  const { adapter, signing, channel } = run.args;
  report.signing.performed = !run.failed && verified.some((p) => p.signed);
  const distributables = verified.filter((p) => p.signingRequired);
  const allSigned =
    !run.failed &&
    distributables.length > 0 &&
    distributables.every((p) => p.signed);
  if (signing && !allSigned) {
    notes.push(
      "Signing was configured but not all distribution artifacts were signed.",
    );
  }
  if (!run.failed && !allSigned) {
    const requirement = adapter.signingRequirement;
    diagnostics.push({
      stage: "report",
      code: CODES.SIGNING_MISSING,
      severity: requirement === "optional" ? "info" : "warning",
      message:
        requirement === "optional"
          ? "Unsigned distribution artifacts run locally but are not store-submittable."
          : `Signing is ${requirement} for channel ${channel}; all distribution artifacts must be signed to be ${requirement === "required-to-run" ? "usable and submittable" : "submittable"}.`,
    });
  }
  run.failed = run.failed || diagnostics.some((d) => d.severity === "error");
  report.ok = !run.failed;
  report.usable =
    report.ok &&
    !(adapter.signingRequirement === "required-to-run" && !allSigned);
  report.submittable = report.ok && allSigned;
}

/**
 * Publish the package, then its report, over the previous output. If either
 * rename fails the new package is removed and the previous one restored.
 */
async function replaceOutput(
  run: PackageRun,
  backup: string,
  moved: boolean,
): Promise<void> {
  const { metadata } = run.args;
  let outputPublished = false;
  try {
    await ownedDirectory(metadata.root, run.staging);
    await rename(run.staging, run.output);
    outputPublished = true;
    await rename(run.stagedReport, run.reportPath);
    run.reportPublished = true;
  } catch (error) {
    if (outputPublished) {
      await removeOwned(run, run.output, true);
    }
    if (moved) {
      await ownedDirectory(metadata.root, dirname(run.output));
      await rename(backup, run.output);
    }
    throw error;
  }
}

async function publishRun(run: PackageRun): Promise<void> {
  const { metadata } = run.args;
  const { output, staging } = run;
  run.report.artifacts = run.verified.map((entry) => ({
    ...entry,
    path: resolve(output, relative(staging, entry.path)),
  }));
  await ownedDirectory(metadata.root, staging);
  await stageReport(run);
  await ownedDirectory(metadata.root, output);
  const backup = `${output}.previous-${crypto.randomUUID()}`;
  let moved = false;
  try {
    await rename(output, backup);
    moved = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  await replaceOutput(run, backup, moved);
  if (moved) {
    await removeOwned(run, backup, true).catch(async (error: unknown) => {
      run.diagnostics.push({
        stage: "report",
        code: CODES.STAGE_FAILED,
        severity: "warning",
        message: `Cannot remove previous output backup: ${errorText(error)}`,
        path: backup,
      });
      await writeReport(run).catch(() => undefined);
    });
  }
}

/** Run the ordered stages after the locks are held, publishing only a run without errors. */
async function executeRun(run: PackageRun): Promise<void> {
  await ownedDirectory(run.args.metadata.root, run.output);
  if (!run.failed) {
    await loadInputManifest(run);
  }
  if (!run.failed) {
    await verifyInputs(run);
  }
  await runAdapterStages(run, run.failed ? [] : planAdapterStages(run));
  await verifyProducedArtifacts(run);
  finalizeReport(run);
  if (run.report.ok) {
    await publishRun(run);
  }
}

/** Remove staging, write the report if it was not published and release both locks even when cleanup fails. */
async function cleanupRun(run: PackageRun, locks: RunLocks): Promise<void> {
  // Nested finally blocks run both lock-release paths even if cleanup fails.
  try {
    await removeOwned(run, run.staging, true);
    if (!run.reportPublished) {
      try {
        await writeReport(run);
      } catch (error) {
        reportFailure(run, error);
      }
    }
    await removeOwned(run, run.stagedReport);
  } finally {
    try {
      try {
        await locks.lock.close();
      } finally {
        await removeOwned(run, run.lockPath);
      }
    } finally {
      await locks.releaseTarget();
    }
  }
}

/**
 * Runs an adapter against a verified build artifact, which adapters must treat
 * as read-only, and returns a structured report. The runner owns ordered
 * stages, diagnostics, output verification and publication. Publication
 * follows successful stages and artifact verification; rollback attempts to
 * restore the prior output if publication fails.
 */
export async function runPackage(args: RunPackageArgs): Promise<PackageReport> {
  const run = createPackageRun(args);
  // JS callers must not turn channel/target names into arbitrary filesystem paths.
  if (run.invalidName) {
    return run.report;
  }
  const locks = await acquireRunLocks(run);
  if (!locks) {
    return run.report;
  }
  try {
    await executeRun(run);
  } catch (error) {
    reportFailure(run, error);
  } finally {
    await cleanupRun(run, locks);
  }
  return run.report;
}
