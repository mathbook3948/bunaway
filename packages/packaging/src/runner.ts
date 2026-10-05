import { lstat, mkdir, realpath, rename, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  type AdapterInput,
  type BuildArtifact,
  type BuildTarget,
  type ChannelId,
  CODES,
  type Diagnostic,
  type PackageAdapter,
  type PackageManifest,
  type PackageReport,
  platformOf,
  type ProducedArtifact,
  type ResolvedPackaging,
  type SigningConfig,
  type StageContext,
  type StageResult,
} from "./contract.ts";
import { ArtifactInputError, loadManifest, verifyArtifact } from "./inputs.ts";

export interface RunPackageArgs {
  metadata: ResolvedPackaging;
  appId: string;
  channel: ChannelId;
  channelConfig: Record<string, unknown>;
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

export function packagingReportPath(root: string, target: BuildTarget, channel: ChannelId): string {
  return resolve(packagingOutputDir(root, target), `${channel}-report.json`);
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

const EMPTY_MANIFEST: PackageManifest = {
  bun: { version: "", target: "", executableSha256: "", licenseSha256: "" },
  assets: {},
  app: { id: "", version: "" },
};

// Executes one channel adapter against an existing build artifact. The runner
// owns stage ordering, diagnostics collection, the atomic output rename and
// the report; adapters own channel semantics only.
export async function runPackage(args: RunPackageArgs): Promise<PackageReport> {
  const { metadata, appId, channel, channelConfig, signing, target, artifact, adapter } = args;
  const diagnostics: Diagnostic[] = [];
  const stages: StageResult[] = [];
  const produced: ProducedArtifact[] = [];
  const verified: PackageReport["artifacts"] = [];
  const notes: string[] = [...(args.notes ?? [])];
  const output = resolve(packagingOutputDir(metadata.root, target), channel);
  await mkdir(dirname(output), { recursive: true });
  const staging = `${output}.building-${crypto.randomUUID()}`;

  let manifest = EMPTY_MANIFEST;
  const platform = platformOf(channel);
  if (
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
  if (diagnostics.length === 0) {
    try {
      manifest = await loadManifest(artifact);
    } catch (error) {
      diagnostics.push({
        stage: "resolve",
        code: error instanceof ArtifactInputError ? error.code : CODES.INPUT_MISSING,
        severity: "error",
        message: error instanceof Error ? error.message : String(error),
        path: resolve(artifact.packageDir, "manifest.json"),
      });
    }
  }

  const input: AdapterInput = {
    channel,
    channelConfig,
    metadata,
    target,
    artifact,
    manifest,
    ...(signing ? { signing } : {}),
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

  let failed = diagnostics.length > 0;
  try {
    if (!failed) {
      const started = Date.now();
      const integrity = await verifyArtifact({ artifact, manifest: input.manifest, channel });
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
        stages.push({ id: stage.id, title: stage.title, status: "skipped", durationMs: 0 });
        continue;
      }
      const started = Date.now();
      const ctx: StageContext = {
        input,
        staging,
        report(diagnostic) {
          diagnostics.push({ stage: stage.id, ...diagnostic });
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
        await mkdir(staging, { recursive: true });
        await stage.run(ctx);
        stages.push({
          id: stage.id,
          title: stage.title,
          status: diagnostics.some((d) => d.severity === "error" && d.stage === stage.id)
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
      if (diagnostics.some((d) => d.severity === "error" && d.stage === stage.id)) failed = true;
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
      for (const entry of produced) {
        const path = isAbsolute(entry.path) ? entry.path : resolve(staging, entry.path);
        try {
          if (!inside(staging, path)) throw new Error("Artifact path escapes staging.");
          const file = await lstat(path);
          if (!file.isFile()) throw new Error("Artifact is not a regular file.");
          const canonicalStaging = await realpath(staging);
          const canonicalPath = await realpath(path);
          if (!inside(canonicalStaging, canonicalPath)) {
            throw new Error("Artifact real path escapes staging.");
          }
          verified.push({
            path: resolve(staging, relative(canonicalStaging, canonicalPath)),
            kind: entry.kind,
            signed: entry.signed,
            signingRequired: entry.signingRequired,
            sha256: await sha256(path),
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
    const allSigned = !failed && distributables.length > 0 && distributables.every((p) => p.signed);
    if (signing && !allSigned) {
      notes.push("Signing was configured but not all distribution artifacts were signed.");
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
    report.usable = report.ok && !(adapter.signingRequirement === "required-to-run" && !allSigned);
    report.submittable = report.ok && allSigned;

    if (report.ok) {
      const backup = `${output}.previous-${crypto.randomUUID()}`;
      let moved = false;
      try {
        await rename(output, backup);
        moved = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      try {
        await rename(staging, output);
      } catch (error) {
        if (moved) await rename(backup, output);
        throw error;
      }
      report.artifacts = verified.map((entry) => ({
        ...entry,
        path: resolve(output, relative(staging, entry.path)),
      }));
      if (moved) {
        await rm(backup, { recursive: true, force: true }).catch((error: unknown) => {
          diagnostics.push({
            stage: "report",
            code: CODES.STAGE_FAILED,
            severity: "warning",
            message: `Cannot remove previous output backup: ${error instanceof Error ? error.message : String(error)}`,
            path: backup,
          });
        });
      }
    }
  } catch (error) {
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
  } finally {
    await rm(staging, { recursive: true, force: true });
    const reportPath = packagingReportPath(metadata.root, target, channel);
    await mkdir(dirname(reportPath), { recursive: true });
    await Bun.write(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  return report;
}
