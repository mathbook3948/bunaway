import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  type ChannelId,
  CODES,
  type PlatformId,
  PLATFORMS,
  type ResolvedPackaging,
  type ResolvedTarget,
  type SigningConfig,
  targetFor,
} from "./contract.ts";
import { IDENTIFIER_PATTERN, type PackagingConfig, SEMVER_PATTERN } from "./config.ts";

export interface ResolvedChannel {
  channelConfig: Record<string, unknown>;
  signing?: SigningConfig;
}

function fail(code: string, message: string): never {
  const error = new Error(message);
  (error as Error & { code?: string }).code = code;
  throw error;
}

// appId (`app.my-app`) is already a valid dotted identifier; append a suffix
// when it is a single label so every platform gets a reverse-DNS shape.
export function deriveIdentifier(appId: string): string {
  return appId.includes(".") ? appId : `${appId}.app`;
}

export function deriveMsixPackageName(identifier: string): string {
  // MSIX Package/Identity/Name: alphanumeric plus . - _, at most 50 chars.
  const name = identifier.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 50);
  if (!/^[A-Za-z0-9]/.test(name)) {
    fail(CODES.CONFIG_INVALID, `Cannot derive an MSIX package name from "${identifier}".`);
  }
  return name;
}

async function icon(root: string, directory: string, name: string): Promise<string> {
  const nameInProject = `${directory ? `${directory}/` : ""}${name}`;
  if (isAbsolute(nameInProject) || nameInProject.split(/[\\/]/).includes("..")) {
    fail(
      CODES.CONFIG_INVALID,
      `bunaway.json.bundle: icon path escapes the project: ${nameInProject}`,
    );
  }
  const path = resolve(root, nameInProject);
  const stat = await lstat(path).catch(() => undefined);
  if (!stat?.isFile()) {
    fail(CODES.CONFIG_INVALID, `bunaway.json.bundle: icon is not a file: ${nameInProject}`);
  }
  const canonical = await realpath(path);
  const rel = relative(await realpath(root), canonical);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    fail(
      CODES.CONFIG_INVALID,
      `bunaway.json.bundle: icon path escapes the project: ${nameInProject}`,
    );
  }
  return canonical;
}

// Merge bunaway.json.bundle with app settings/package.json into the single metadata
// source every adapter reads. `channel` selects which channels.<id> entry the
// caller wants; channels must be declared explicitly (an empty object means
// "package me with defaults") so a store channel is never packaged by
// accident.
export async function resolvePackaging(args: {
  root: string;
  config: PackagingConfig;
  appId: string;
  title: string;
  projectVersion: string;
  channel: ChannelId;
}): Promise<{ metadata: ResolvedPackaging; channel: ResolvedChannel }> {
  const { root, config, appId, title, projectVersion, channel } = args;
  const channelConfig = config.channels?.[channel];
  if (!channelConfig) {
    fail(
      CODES.CHANNEL_NOT_CONFIGURED,
      `bunaway.json.bundle has no channels.${channel} entry; add it ({} uses defaults) to enable this channel.`,
    );
  }
  const name = config.name ?? title;
  const identifier = config.identifier ?? deriveIdentifier(appId);
  if (!IDENTIFIER_PATTERN.test(identifier)) {
    fail(CODES.CONFIG_INVALID, `Identifier "${identifier}" is not a valid reverse-DNS identifier.`);
  }
  const semver = config.release?.version ?? projectVersion;
  if (!SEMVER_PATTERN.test(semver)) {
    fail(
      CODES.CONFIG_INVALID,
      `Package version "${semver}" is not numeric semver x.y.z; set release.version in bunaway.json.bundle.`,
    );
  }
  const parts = semver.split(".").map(Number);
  if (parts.some((part) => part > 65534)) {
    fail(CODES.CONFIG_INVALID, `Version parts must be <= 65534 for MSIX compatibility: ${semver}.`);
  }
  const build = config.release?.build ?? 0;
  const icons: Record<string, string> = {};
  const directory = config.icons?.directory ?? "";
  for (const platform of PLATFORMS) {
    for (const [key, value] of Object.entries(config.icons?.[platform] ?? {})) {
      icons[`${platform}.${key}`] = await icon(root, directory, value);
    }
  }
  const targets: ResolvedTarget[] = (config.targets ?? []).map((target) => {
    const result: ResolvedTarget = {
      platform: target.platform as PlatformId,
      arch: target.arch as ResolvedTarget["arch"],
    };
    targetFor(result.platform, result.arch); // throws for unsupported combos
    if (target.minVersion !== undefined) result.minVersion = target.minVersion;
    return result;
  });
  const metadata: ResolvedPackaging = {
    root,
    name,
    identifier,
    publisher: { display: config.publisher?.display ?? name },
    version: { semver, build, msix: `${semver}.${build}` },
    icons,
    targets,
  };
  if (config.publisher?.identity !== undefined) {
    metadata.publisher.identity = config.publisher.identity;
  }
  const resolved: ResolvedChannel = { channelConfig };
  const signing = channelConfig.signing ?? config.signing;
  if (signing) resolved.signing = signing as SigningConfig;
  return { metadata, channel: resolved };
}
