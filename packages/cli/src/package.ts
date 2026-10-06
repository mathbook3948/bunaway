import {
  adapterFor,
  artifactPaths,
  type BuildArtifact,
  type ChannelId,
  CODES,
  isChannelId,
  PACKAGING_CHANNELS,
  type PackageReport,
  packagingReportPath,
  platformOf,
  registeredChannels,
  resolvePackaging,
  runPackage,
  targetFor,
} from "@bunaway/packaging";
import { resolve } from "node:path";
import { buildProject, currentTarget } from "./build.ts";
import { readProjectSettings, validateProject } from "./config.ts";
import { json } from "./files.ts";

// Bundle settings are optional for dev/build and required for packaging.
export async function validatePackagingConfig(root: string): Promise<void> {
  await readProjectSettings(root);
}

// `bunaway package <channel>` consumes the channel-neutral artifact produced
// by `bunaway build` (or builds it first with --build) and runs the channel
// adapter. Exit semantics: the returned report carries ok/usable/submittable;
// the CLI maps ok to its exit code.
export async function packageProject(
  directory: string,
  channelName: string,
  options: { build?: boolean } = {},
): Promise<PackageReport> {
  if (!isChannelId(channelName)) {
    throw new Error(
      `Unknown channel: ${channelName}. Supported channels: ${PACKAGING_CHANNELS.join(", ")}.`,
    );
  }
  const channel = channelName as ChannelId;
  const project = await validateProject(directory);
  const config = project.bundle;
  if (!config)
    throw new Error("Packaging requires bunaway.json.bundle (or legacy packaging.json).");
  const appPackage = (await json(resolve(project.root, "package.json"))) as { version?: string };
  const { metadata, channel: resolvedChannel } = await resolvePackaging({
    root: project.root,
    config,
    appId: project.app.appId,
    title: project.app.title,
    projectVersion: appPackage.version ?? "",
    channel,
  });
  const platform = platformOf(channel);
  const nativeTarget = currentTarget();
  if (!nativeTarget.startsWith(`${platform}-`)) {
    throw new Error(
      `Channel ${channel} requires ${platform}; the native host target is ${nativeTarget}.`,
    );
  }
  const declared = metadata.targets.find((target) => target.platform === platform);
  if (metadata.targets.length > 0 && !declared) {
    throw new Error(`Channel ${channel} has no ${platform} target declared in bundle settings.`);
  }
  const target = declared ? targetFor(platform, declared.arch) : nativeTarget;
  if (target !== nativeTarget) {
    throw new Error(
      `Channel ${channel} targets ${target}; the MVP packages only the native host target.`,
    );
  }
  const adapter = adapterFor(channel);
  if (!adapter) {
    const available = registeredChannels();
    throw new Error(
      `No adapter registered for channel ${channel}` +
        (available.length ? ` (available: ${available.join(", ")})` : " (no adapters installed)") +
        ".",
    );
  }
  const notes: string[] = [];
  let artifact: BuildArtifact;
  if (options.build) {
    const built = await buildProject(directory);
    artifact = { dir: built.output, packageDir: built.package, executable: built.executable };
    notes.push("Build artifact produced in this run.");
  } else {
    artifact = artifactPaths({ root: project.root, target, appId: project.app.appId });
  }
  const report = await runPackage({
    metadata,
    appId: project.app.appId,
    channel,
    channelConfig: resolvedChannel.channelConfig,
    ...(resolvedChannel.signing ? { signing: resolvedChannel.signing } : {}),
    target,
    artifact,
    adapter,
    notes,
  });
  const lockFailed = report.diagnostics.some((diagnostic) => diagnostic.code === CODES.LOCK_FAILED);
  if (!lockFailed) console.log(`Report: ${packagingReportPath(project.root, target, channel)}`);
  for (const diagnostic of report.diagnostics) {
    if (diagnostic.severity === "info") continue;
    console.log(
      `${diagnostic.severity.toUpperCase()} [${diagnostic.code}] ${diagnostic.stage}: ${diagnostic.message}`,
    );
  }
  for (const artifactPath of report.artifacts) {
    console.log(`Artifact: ${artifactPath.path} (${artifactPath.kind})`);
  }
  console.log(
    report.ok
      ? `Packaged ${channel}: usable=${report.usable} submittable=${report.submittable}`
      : lockFailed
        ? `Packaging ${channel} failed; no report was published. See diagnostics above.`
        : `Packaging ${channel} failed; see the report for diagnostics.`,
  );
  return report;
}
