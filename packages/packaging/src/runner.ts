import { mkdir, rename, rm, stat } from "node:fs/promises";
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
  type ProducedArtifact,
  type ResolvedPackaging,
  type SigningConfig,
  type StageContext,
  type StageResult,
} from "./contract.ts";
import { loadManifest, verifyArtifact } from "./inputs.ts";

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
  const notes: string[] = [...(args.notes ?? [])];
  const output = resolve(packagingOutputDir(metadata.root, target), channel);
  await mkdir(dirname(output), { recursive: true });
  const staging = `${output}.building-${crypto.randomUUID()}`;

  let manifest = EMPTY_MANIFEST;
  try {
    manifest = await loadManifest(artifact);
  } catch (error) {
    diagnostics.push({
      stage: "resolve",
      code: CODES.INPUT_MISSING,
      severity: "error",
      message: error instanceof Error ? error.message : String(error),
      path: resolve(artifact.packageDir, "manifest.json"),
    });
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
          produced.push({ path, kind, signed: options?.signed ?? false });
        },
      };
      try {
        await mkdir(staging, { recursive: true });
        await stage.run(ctx);
        stages.push({
          id: stage.id,
          title: stage.title,
          status: "ok",
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

    report.signing.performed = produced.some((p) => p.signed);
    if (signing && !report.signing.performed) {
      notes.push("Signing was configured but no artifact was signed; check the sign stage output.");
    }
    if (!signing) {
      const requirement = adapter.signingRequirement;
      diagnostics.push({
        stage: "report",
        code: CODES.SIGNING_MISSING,
        severity: requirement === "optional" ? "info" : "warning",
        message:
          requirement === "optional"
            ? "No signing configured; artifacts run locally but expect user-trust warnings."
            : `Signing is ${requirement} for channel ${channel}; unsigned output is not distributable or submittable.`,
      });
    }

    failed = failed || diagnostics.some((d) => d.severity === "error");
    report.ok = !failed;
    report.usable =
      report.ok && !(adapter.signingRequirement === "required-to-run" && !report.signing.performed);
    report.submittable = report.ok && report.signing.performed;

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
      if (moved) await rm(backup, { recursive: true, force: true });
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
    for (const producedArtifact of produced) {
      // Artifacts registered inside staging move with the atomic rename;
      // anything else keeps its absolute path in the report.
      const declared = isAbsolute(producedArtifact.path)
        ? producedArtifact.path
        : resolve(staging, producedArtifact.path);
      const insideStaging = (() => {
        const rel = relative(staging, declared);
        return (
          rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith("../") && !isAbsolute(rel)
        );
      })();
      const path =
        report.ok && insideStaging ? resolve(output, relative(staging, declared)) : declared;
      try {
        report.artifacts.push({
          path,
          kind: producedArtifact.kind,
          signed: producedArtifact.signed,
          sha256: await sha256(path),
          size: (await stat(path)).size,
        });
      } catch {
        diagnostics.push({
          stage: "report",
          code: CODES.INPUT_UNEXPECTED,
          severity: "warning",
          message: `Declared artifact is missing: ${producedArtifact.path}`,
          path,
        });
      }
    }
    const reportPath = packagingReportPath(metadata.root, target, channel);
    await mkdir(dirname(reportPath), { recursive: true });
    await Bun.write(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  return report;
}
