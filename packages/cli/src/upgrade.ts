import { lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isRecord } from "@bunaway/protocol";
import { hasSdkOverride, type Release, release } from "./distribution.ts";
import { installedPackageRoot, isOptionalDependency, json } from "./files.ts";

type Status = "OK" | "FAIL" | "SKIP" | "CHANGE";

export interface UpgradeLine {
  status: Status;
  name: string;
  detail: string;
  /** A blocking failure needs a manual edit, so `--write` changes nothing. */
  blocking?: boolean;
}

export interface UpgradePlan {
  lines: UpgradeLine[];
  /** The `package.json` text read while planning; the write is refused if it changed since. */
  original: string;
  /** The text to write, identical to `original` when nothing changes. */
  next: string;
}

type PackageJson = Record<string, unknown>;

const dependencyFields = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

/** Specifiers that do not name a registry version are left to the project. */
function isExternalSpecifier(specifier: string): boolean {
  return specifier.includes(":") || specifier.endsWith(".tgz");
}

/** Indentation, line ending, BOM and final newline of the file, so the rewrite keeps them. */
function layout(text: string): {
  bom: string;
  indent: string;
  eol: string;
  final: string;
} {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  return {
    bom: text.startsWith("﻿") ? "﻿" : "",
    indent: /^[ \t]+(?=")/m.exec(text)?.[0] ?? "",
    eol,
    final: text.endsWith("\n") ? eol : "",
  };
}

function serialize(value: PackageJson, text: string): string {
  const { bom, indent, eol, final } = layout(text);
  const body = JSON.stringify(value, null, indent || undefined);
  return `${bom}${body.replaceAll("\n", eol)}${final}`;
}

/** Plan the pin of one dependency field entry, or report why it is left alone. */
function planDependency(
  lines: UpgradeLine[],
  dependencies: Record<string, unknown>,
  name: string,
  known: ReadonlySet<string>,
  version: string,
): void {
  const specifier = dependencies[name];
  if (!known.has(name)) {
    lines.push({
      status: "FAIL",
      name,
      detail: "not a package of this framework release; remove or replace it",
      blocking: true,
    });
  } else if (typeof specifier !== "string") {
    lines.push({
      status: "FAIL",
      name,
      detail: "the version must be a string",
      blocking: true,
    });
  } else if (isExternalSpecifier(specifier)) {
    lines.push({
      status: "SKIP",
      name,
      detail: `${specifier} is not a registry version and is left as is`,
    });
  } else if (specifier !== version) {
    dependencies[name] = version;
    lines.push({
      status: "CHANGE",
      name,
      detail: `${specifier} -> ${version}`,
    });
  } else {
    lines.push({
      status: "OK",
      name,
      detail: version,
    });
  }
}

/** Plan a plain string field that must equal `expected`; an absent optional field is left absent. */
function planField(
  lines: UpgradeLine[],
  owner: PackageJson,
  key: string,
  name: string,
  expected: string,
  required: boolean,
): void {
  const current = owner[key];
  if (current === undefined && !required) {
    return;
  }
  if (current === expected) {
    lines.push({
      status: "OK",
      name,
      detail: expected,
    });
    return;
  }
  owner[key] = expected;
  lines.push({
    status: "CHANGE",
    name,
    detail: `${current === undefined ? "(unset)" : String(current)} -> ${expected}`,
  });
}

/** Compare the version installed in node_modules with the version the project will declare. */
async function checkInstalled(
  project: string,
  pkg: PackageJson,
  name: string,
  version: string,
): Promise<UpgradeLine> {
  try {
    const root = await installedPackageRoot(project, name);
    const installed = (
      (await json(resolve(root, "package.json"))) as PackageJson
    ).version;
    return installed === version
      ? {
          status: "OK",
          name: `installed ${name}`,
          detail: version,
        }
      : {
          status: "FAIL",
          name: `installed ${name}`,
          detail: `${String(installed)} is installed; run bun install after the update`,
        };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    return isOptionalDependency(pkg, name)
      ? {
          status: "SKIP",
          name: `installed ${name}`,
          detail: "optional and not installed",
        }
      : {
          status: "FAIL",
          name: `installed ${name}`,
          detail: "not installed; run bun install after the update",
        };
  }
}

async function readPackageText(project: string): Promise<string> {
  const path = resolve(project, "package.json");
  const info = await lstat(path);
  if (!info.isFile()) {
    throw new Error(`${path} must be a regular file, not a link.`);
  }
  return readFile(path, "utf8");
}

/** Compare the project's framework pins with the running CLI's release without writing anything. */
export async function planUpgrade(
  project: string,
  target?: Release,
): Promise<UpgradePlan> {
  const actual = target ?? (await release());
  const original = await readPackageText(project);
  const pkg: unknown = JSON.parse(original.replace(/^﻿/, ""));
  if (!isRecord(pkg)) {
    throw new Error("package.json must contain an object.");
  }
  const known = new Set([
    ...Object.values(actual.packages),
    ...Object.values(actual.plugins),
  ]);
  const lines: UpgradeLine[] = [];
  const declared: string[] = [];
  for (const field of dependencyFields) {
    const dependencies = pkg[field];
    if (!isRecord(dependencies)) {
      continue;
    }
    for (const name of Object.keys(dependencies).filter((key) =>
      key.startsWith("@bunaway/"),
    )) {
      planDependency(lines, dependencies, name, known, actual.version);
      if (typeof dependencies[name] === "string" && known.has(name)) {
        declared.push(name);
      }
    }
  }
  if (hasSdkOverride(pkg.overrides) || hasSdkOverride(pkg.resolutions)) {
    lines.push({
      status: "FAIL",
      name: "overrides",
      detail: "remove @bunaway/ rules from overrides and resolutions",
      blocking: true,
    });
  }
  planField(
    lines,
    pkg,
    "packageManager",
    "packageManager",
    `bun@${actual.bun}`,
    true,
  );
  if (isRecord(pkg.engines)) {
    planField(lines, pkg.engines, "bun", "engines.bun", actual.bun, false);
  }
  const changed = lines.some((line) => line.status === "CHANGE");
  const next = changed ? serialize(pkg, original) : original;
  if (
    changed &&
    serialize(JSON.parse(original.replace(/^﻿/, "")), original) !== original
  ) {
    lines.push({
      status: "FAIL",
      name: "package.json",
      detail: "its formatting cannot be kept by a rewrite; edit it by hand",
      blocking: true,
    });
  }
  const unique = [
    ...new Set(declared),
  ];
  for (const name of unique) {
    lines.push(await checkInstalled(project, pkg, name, actual.version));
  }
  return {
    lines,
    original,
    next,
  };
}

/** Replace package.json through a temporary file, refusing if it changed after planning. */
export async function applyUpgrade(
  project: string,
  plan: UpgradePlan,
): Promise<void> {
  if (plan.next === plan.original) {
    return;
  }
  const path = resolve(project, "package.json");
  const temporary = `${path}.${process.pid}.tmp`;
  const info = await lstat(path);
  try {
    await writeFile(temporary, plan.next, {
      flag: "wx",
      mode: info.mode & 0o777,
    });
    if ((await readPackageText(project)) !== plan.original) {
      throw new Error(
        "package.json changed while upgrading; nothing was written.",
      );
    }
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, {
      force: true,
    });
    throw error;
  }
}

/** Print the plan and, with `write`, apply it; the return value is the process exit code. */
export async function upgradeProject(
  directory: string,
  write: boolean,
  target?: Release,
): Promise<number> {
  const plan = await planUpgrade(directory, target);
  for (const line of plan.lines) {
    console.log(`${line.status} ${line.name}: ${line.detail}`);
  }
  const blocked = plan.lines.some((line) => line.blocking);
  const changes = plan.lines.some((line) => line.status === "CHANGE");
  if (blocked) {
    console.log("Nothing was written; fix the FAIL entries above first.");
    return 1;
  }
  if (!write) {
    const stale = plan.lines.some((line) => line.status === "FAIL");
    console.log(
      changes
        ? "Run bunaway upgrade --write to apply the changes."
        : "Framework pins are up to date.",
    );
    return changes || stale ? 1 : 0;
  }
  await applyUpgrade(directory, plan);
  if (changes) {
    console.log(
      "Updated package.json. Run bun install, then bunaway validate.",
    );
  }
  return 0;
}
