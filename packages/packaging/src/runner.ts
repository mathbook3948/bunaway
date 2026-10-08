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
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
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

export function packagingOutputDir(root: string, target: BuildTarget): string {
  return resolve(root, "dist", target, "packaged");
}

export function packagingReportPath(
  root: string,
  target: BuildTarget,
  channel: ChannelId,
): string {
  return resolve(packagingOutputDir(root, target), `${channel}-report.json`);
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

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

// Executes one channel adapter against an existing build artifact. The runner
// owns stage ordering, diagnostics collection, the atomic output rename and
// the report; adapters own channel semantics only.
export async function runPackage(args: RunPackageArgs): Promise<PackageReport> {
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
  const produced: ProducedArtifact[] = [];
  const verified: PackageReport["artifacts"] = [];
  const notes: string[] = [
    ...(args.notes ?? []),
  ];
  const output = resolve(packagingOutputDir(metadata.root, target), channel);
  const staging = `${output}.building-${crypto.randomUUID()}`;
  const reportPath = packagingReportPath(metadata.root, target, channel);
  const stagedReport = `${reportPath}.building-${crypto.randomUUID()}`;
  let reportPublished = false;

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

  const input: AdapterInput = {
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
  };
  const report: PackageReport = {
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
  };
  // JS callers must not turn channel/target names into arbitrary filesystem paths.
  if (invalidName) {
    return report;
  }

  let failed = diagnostics.length > 0;
  function reportFailure(error: unknown) {
    report.ok = false;
    report.usable = false;
    report.submittable = false;
    report.signing.performed = false;
    report.artifacts = [];
    diagnostics.push({
      stage: "report",
      code: CODES.STAGE_FAILED,
      severity: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
  async function remove(path: string, recursive = false) {
    if (await ownedDirectory(metadata.root, dirname(path))) {
      // rm unlinks a leaf symlink/junction; only its parent must be owned.
      await rm(path, {
        recursive,
        force: true,
      });
    }
  }
  async function stageReport() {
    await remove(stagedReport);
    await writeFile(stagedReport, `${JSON.stringify(report, null, 2)}\n`, {
      flag: "wx",
    });
  }
  async function writeReport() {
    await stageReport();
    await rename(stagedReport, reportPath);
  }
  const lockPath = `${output}.lock`;
  let lock: FileHandle;
  let releaseTarget: (() => Promise<void>) | undefined;
  try {
    releaseTarget = await acquirePackageInputLock(metadata.root, target);
    await ownedDirectory(metadata.root, dirname(output), true);
    lock = await open(lockPath, "wx");
  } catch (error) {
    await releaseTarget?.();
    diagnostics.push({
      stage: "resolve",
      code: CODES.LOCK_FAILED,
      severity: "error",
      message:
        error instanceof TargetLockError
          ? error.message
          : (error as NodeJS.ErrnoException).code === "EEXIST"
            ? `Packaging channel ${channel} is locked; another run may be active.`
            : `Cannot acquire package lock: ${error instanceof Error ? error.message : String(error)}`,
      path: error instanceof TargetLockError ? error.path : lockPath,
    });
    return report;
  }
  try {
    await ownedDirectory(metadata.root, output);
    if (!failed) {
      try {
        input.manifest = await loadManifest(artifact);
      } catch (error) {
        diagnostics.push({
          stage: "resolve",
          code:
            error instanceof ArtifactInputError
              ? error.code
              : CODES.INPUT_MISSING,
          severity: "error",
          message: error instanceof Error ? error.message : String(error),
          path: resolve(artifact.packageDir, "manifest.json"),
        });
        failed = true;
      }
    }
    if (!failed) {
      const started = Date.now();
      const integrity = await verifyArtifact({
        artifact,
        manifest: input.manifest,
        channel,
      });
      if (input.manifest.app.id !== appId) {
        integrity.push({
          stage: "verify",
          code: CODES.INPUT_UNEXPECTED,
          severity: "error",
          message: `Build artifact belongs to app ${input.manifest.app.id}, not ${appId}; run bunaway build again.`,
          path: resolve(artifact.packageDir, "manifest.json"),
        });
      }
      diagnostics.push(...integrity);
      failed = integrity.some((d) => d.severity === "error");
      stages.push({
        id: "verify",
        title: "Verify build artifact inputs",
        status: failed ? "failed" : "ok",
        durationMs: Date.now() - started,
      });
    }
    let adapterStages: ReturnType<PackageAdapter["stages"]> = [];
    if (!failed) {
      try {
        adapterStages = adapter.stages(input);
      } catch (error) {
        diagnostics.push({
          stage: "resolve",
          code: CODES.CONFIG_INVALID,
          severity: "error",
          message: error instanceof Error ? error.message : String(error),
        });
        failed = true;
      }
    }
    for (const stage of adapterStages) {
      if (failed) {
        stages.push({
          id: stage.id,
          title: stage.title,
          status: "skipped",
          durationMs: 0,
        });
        continue;
      }
      const started = Date.now();
      const ctx: StageContext = {
        input,
        staging,
        report(diagnostic) {
          diagnostics.push({
            stage: stage.id,
            ...diagnostic,
          });
        },
        addArtifact(path, kind, options) {
          produced.push({
            path,
            kind,
            signed: options?.signed ?? false,
            signingRequired: options?.signingRequired ?? true,
          });
        },
      };
      try {
        await ownedDirectory(metadata.root, staging, true);
        await stage.run(ctx);
        stages.push({
          id: stage.id,
          title: stage.title,
          status: diagnostics.some(
            (d) => d.severity === "error" && d.stage === stage.id,
          )
            ? "failed"
            : "ok",
          durationMs: Date.now() - started,
        });
      } catch (error) {
        diagnostics.push({
          stage: stage.id,
          code: CODES.STAGE_FAILED,
          severity: "error",
          message: error instanceof Error ? error.message : String(error),
        });
        stages.push({
          id: stage.id,
          title: stage.title,
          status: "failed",
          durationMs: Date.now() - started,
        });
      }
      if (
        diagnostics.some((d) => d.severity === "error" && d.stage === stage.id)
      ) {
        failed = true;
      }
    }

    const started = Date.now();
    if (!failed) {
      if (produced.length === 0) {
        diagnostics.push({
          stage: "verify-artifact",
          code: CODES.VERIFY_FAILED,
          severity: "error",
          message: "The adapter produced no artifacts.",
        });
        failed = true;
      }
      if (!failed) {
        try {
          await verifyStagingLinks(staging);
        } catch (error) {
          diagnostics.push({
            stage: "verify-artifact",
            code: CODES.VERIFY_FAILED,
            severity: "error",
            message: error instanceof Error ? error.message : String(error),
            path: staging,
          });
          failed = true;
        }
      }
      for (const entry of produced) {
        let path = entry.path;
        try {
          if (
            entry.path
              .split(process.platform === "win32" ? /[\\/]/ : /\//)
              .includes("..")
          ) {
            throw new Error(
              "Artifact path contains ambiguous parent components.",
            );
          }
          path = isAbsolute(entry.path)
            ? entry.path
            : resolve(staging, entry.path);
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
          verified.push({
            path: resolve(staging, relative(canonicalStaging, canonicalPath)),
            kind: entry.kind,
            signed: entry.signed,
            signingRequired: entry.signingRequired,
            sha256: await sha256(canonicalPath),
            size: file.size,
          });
        } catch (error) {
          diagnostics.push({
            stage: "verify-artifact",
            code: CODES.VERIFY_FAILED,
            severity: "error",
            message: `Cannot verify declared artifact ${entry.path}: ${error instanceof Error ? error.message : String(error)}`,
            path,
          });
          failed = true;
        }
      }
      stages.push({
        id: "verify-artifact",
        title: "Verify produced artifacts",
        status: failed ? "failed" : "ok",
        durationMs: Date.now() - started,
      });
    } else {
      stages.push({
        id: "verify-artifact",
        title: "Verify produced artifacts",
        status: "skipped",
        durationMs: 0,
      });
    }

    report.signing.performed = !failed && verified.some((p) => p.signed);
    const distributables = verified.filter((p) => p.signingRequired);
    const allSigned =
      !failed &&
      distributables.length > 0 &&
      distributables.every((p) => p.signed);
    if (signing && !allSigned) {
      notes.push(
        "Signing was configured but not all distribution artifacts were signed.",
      );
    }
    if (!failed && !allSigned) {
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

    failed = failed || diagnostics.some((d) => d.severity === "error");
    report.ok = !failed;
    report.usable =
      report.ok &&
      !(adapter.signingRequirement === "required-to-run" && !allSigned);
    report.submittable = report.ok && allSigned;

    if (report.ok) {
      report.artifacts = verified.map((entry) => ({
        ...entry,
        path: resolve(output, relative(staging, entry.path)),
      }));
      await stageReport();
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
      let outputPublished = false;
      try {
        await rename(staging, output);
        outputPublished = true;
        await rename(stagedReport, reportPath);
        reportPublished = true;
      } catch (error) {
        if (outputPublished) {
          await remove(output, true);
        }
        if (moved) {
          await ownedDirectory(metadata.root, dirname(output));
          await rename(backup, output);
        }
        throw error;
      }
      if (moved) {
        await remove(backup, true).catch(async (error: unknown) => {
          diagnostics.push({
            stage: "report",
            code: CODES.STAGE_FAILED,
            severity: "warning",
            message: `Cannot remove previous output backup: ${error instanceof Error ? error.message : String(error)}`,
            path: backup,
          });
          await writeReport().catch(() => undefined);
        });
      }
    }
  } catch (error) {
    reportFailure(error);
  } finally {
    try {
      await remove(staging, true);
      if (!reportPublished) {
        try {
          await writeReport();
        } catch (error) {
          reportFailure(error);
        }
      }
      await remove(stagedReport);
    } finally {
      try {
        try {
          await lock.close();
        } finally {
          await remove(lockPath);
        }
      } finally {
        await releaseTarget?.();
      }
    }
  }
  return report;
}
