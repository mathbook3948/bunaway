/**
 * Check that every package the framework release publishes is installable from its tarball,
 * without publishing anything. The check packs the framework into a temporary directory with
 * `packFramework`, reads each tarball with `tar`, and audits the file list and `package.json`
 * against `framework.json`.
 *
 * Usage:
 *   bun scripts/check-release-packages.ts
 *
 * Exit code 1 lists each problem; 0 means every tarball passed. Values that wait on the
 * repository owner (`private`, license, `publishConfig`) are listed as pending, not as failures.
 */
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, relative, resolve } from "node:path";
import { packageFilename, release } from "#cli/distribution";
import { packFramework } from "#cli-scripts/pack";

const WORKSPACE_PREFIXES = [
  "workspace:",
  "file:",
  "link:",
] as const;
const DEPENDENCY_FIELDS = [
  "dependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;
const FORBIDDEN_FILE_PATTERN =
  /(^|\/)(\.env[^/]*|\.npmrc|[^/]*\.(pem|key|p12|pfx)|[^/]*\.(test|spec)\.[cm]?[jt]sx?)$/;
const SOURCE_FILE_PATTERN = /\.(ts|tsx|mts|js|mjs)$/;
/**
 * Static `from "x"` clauses (including `import type` and `import { type A }`) and `import("x")`
 * type references, which the transpiler's import scan drops. `stripNonCode` runs first so text
 * inside comments and string or template literals is not counted.
 */
const FROM_CLAUSE_PATTERN = /\bfrom\s*["']([^"']+)["']/g;
const IMPORT_TYPE_PATTERN = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
/** What may precede a string literal for it to be a module specifier. */
const SPECIFIER_LEAD_PATTERN = /(?:\bfrom|\bimport\s*\(?)\s*$/;
const LEAD_WINDOW = 24;

/** One tarball as read back from disk: its file list and the sources of its code files. */
export type PackedPackage = {
  /** Paths relative to the package root, with the tarball's `package/` prefix removed. */
  files: string[];
  manifest: Record<string, unknown>;
  /** Source text by relative path, for the code files that the import check scans. */
  sources: ReadonlyMap<string, string>;
};

/** The release the tarballs must match. */
export type ReleaseExpectation = {
  version: string;
  /** Every package name the release publishes. */
  names: ReadonlySet<string>;
};

function collectTargets(value: unknown, into: string[]): void {
  if (typeof value === "string") {
    into.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) {
      collectTargets(item, into);
    }
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) {
      collectTargets(item, into);
    }
  }
}

function targetsOf(manifest: Record<string, unknown>): string[] {
  const targets: string[] = [];
  collectTargets(manifest.exports, targets);
  collectTargets(manifest.types, targets);
  collectTargets(manifest.main, targets);
  collectTargets(manifest.bin, targets);
  return targets.filter((target) => target.startsWith("./"));
}

/** Index just past the comment starting at `start`, or undefined when no comment starts there. */
function commentEnd(source: string, start: number): number | undefined {
  if (source.startsWith("//", start)) {
    const end = source.indexOf("\n", start);
    return end === -1 ? source.length : end;
  }
  if (source.startsWith("/*", start)) {
    const end = source.indexOf("*/", start + 2);
    return end === -1 ? source.length : end + 2;
  }
  return undefined;
}

/** Index just past the string or template literal that opens at `start`, honoring backslash escapes. */
function literalEnd(source: string, start: number): number {
  const quote = source[start];
  let index = start + 1;
  while (index < source.length && source[index] !== quote) {
    index += source[index] === "\\" ? 2 : 1;
  }
  return index + 1;
}

/**
 * Remove comments and blank every string or template literal except a module specifier (a quoted
 * string right after `from` or `import`). Regexes can then read import clauses without matching
 * example text. A regex literal that contains a quote or `//` can confuse this scan, which is
 * accepted: the shipped sources are checked against it by `release:check` itself.
 */
export function stripNonCode(source: string): string {
  let code = "";
  let index = 0;
  while (index < source.length) {
    const skipped = commentEnd(source, index);
    if (skipped !== undefined) {
      code += " ";
      index = skipped;
      continue;
    }
    const char = source.charAt(index);
    if (char !== '"' && char !== "'" && char !== "`") {
      code += char;
      index += 1;
      continue;
    }
    const end = literalEnd(source, index);
    const isSpecifier =
      char !== "`" && SPECIFIER_LEAD_PATTERN.test(code.slice(-LEAD_WINDOW));
    code += isSpecifier ? source.slice(index, end) : '""';
    index = end;
  }
  return code;
}

/** Bundled output names Node modules without the `node:` prefix, so the builtin list is needed too. */
const NODE_BUILTINS: ReadonlySet<string> = new Set(builtinModules);

function packageOfImport(specifier: string): string | undefined {
  if (
    specifier.startsWith(".") ||
    specifier.startsWith("#") ||
    specifier.startsWith("node:") ||
    specifier.startsWith("bun:") ||
    specifier === "bun" ||
    NODE_BUILTINS.has(specifier.split("/")[0] ?? specifier)
  ) {
    return undefined;
  }
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/** Audit context for one tarball: records problems under the package name. */
type Audit = {
  packed: PackedPackage;
  expected: ReleaseExpectation;
  name: string;
  fail: (message: string) => void;
};

function dependencyProblems(
  field: string,
  dependency: string,
  range: string,
  expected: ReleaseExpectation,
): string[] {
  const label = `${field}.${dependency}`;
  const problems: string[] = [];
  if (WORKSPACE_PREFIXES.some((prefix) => range.startsWith(prefix))) {
    problems.push(`${label} keeps the unpublishable range ${range}`);
  }
  if (!dependency.startsWith("@bunaway/")) {
    return problems;
  }
  if (!expected.names.has(dependency)) {
    problems.push(`${label} is not published by the release`);
  } else if (range !== expected.version) {
    problems.push(
      `${label} is ${range}, not the exact release version ${expected.version}`,
    );
  }
  return problems;
}

/** Check identity, publishable fields and dependency ranges; returns the declared dependency names. */
function auditManifest({ packed, expected, name, fail }: Audit): Set<string> {
  const { manifest } = packed;
  if (!expected.names.has(name)) {
    fail("is not a package of the release in framework.json");
  }
  if (manifest.version !== expected.version) {
    fail(
      `version ${String(manifest.version)} differs from the release version ${expected.version}`,
    );
  }
  for (const field of [
    "scripts",
    "devDependencies",
  ]) {
    if (manifest[field] !== undefined) {
      fail(`${field} must not be published`);
    }
  }
  const declared = new Set<string>();
  for (const field of DEPENDENCY_FIELDS) {
    for (const [dependency, range] of Object.entries(manifest[field] ?? {})) {
      declared.add(dependency);
      if (typeof range !== "string") {
        fail(`${field}.${dependency} is not a version range string`);
        continue;
      }
      for (const problem of dependencyProblems(
        field,
        dependency,
        range,
        expected,
      )) {
        fail(problem);
      }
    }
  }
  return declared;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whether a subpath pattern such as `./dist/native/*.js` is matched by any packed file. */
function patternIsPacked(target: string, files: readonly string[]): boolean {
  const pattern = new RegExp(
    `^${target.slice(2).split("*").map(escapeRegExp).join(".+")}$`,
  );
  return files.some((file) => pattern.test(file));
}

/** Check that the tarball holds every file package.json points at and a license, and nothing secret or test-only. */
function auditFiles({ packed, fail }: Audit): void {
  const present = new Set(packed.files);
  const hasPlatforms = packed.files.some((file) =>
    file.startsWith("src/platforms/"),
  );
  for (const target of targetsOf(packed.manifest)) {
    if (target.includes("*")) {
      // A plugin without native adapters (no `src/platforms/`) keeps the pattern its scaffold writes.
      if (hasPlatforms && !patternIsPacked(target, packed.files)) {
        fail(`${target} named by package.json matches no file in the tarball`);
      }
    } else if (!present.has(target.slice(2))) {
      fail(`${target} named by package.json is not in the tarball`);
    }
  }
  for (const file of packed.files) {
    if (FORBIDDEN_FILE_PATTERN.test(file)) {
      fail(`${file} must not be published`);
    }
  }
  if (!present.has("LICENSE.txt") && !present.has("FRAMEWORK-LICENSE.txt")) {
    fail("has no license file");
  }
}

/** Check that every bare import in the packed code names a declared dependency or the package itself. */
function auditImports(
  { packed, name, fail }: Audit,
  declared: ReadonlySet<string>,
): void {
  const own = new Set([
    name,
    ...Object.keys((packed.manifest.imports ?? {}) as Record<string, unknown>),
  ]);
  const transpiler = new Bun.Transpiler({
    loader: "ts",
  });
  for (const [file, source] of packed.sources) {
    if (!SOURCE_FILE_PATTERN.test(file)) {
      continue;
    }
    const code = stripNonCode(source);
    const specifiers = [
      ...transpiler.scanImports(source).map((entry) => entry.path),
      ...[
        ...code.matchAll(FROM_CLAUSE_PATTERN),
        ...code.matchAll(IMPORT_TYPE_PATTERN),
      ].map((match) => match[1] ?? ""),
    ];
    for (const specifier of specifiers) {
      const dependency = packageOfImport(specifier);
      if (dependency && !declared.has(dependency) && !own.has(dependency)) {
        fail(
          `${file} imports ${dependency}, which package.json does not declare`,
        );
      }
    }
  }
}

/** Problems found in one tarball; an empty list means the package is installable. */
export function auditPackedPackage(
  packed: PackedPackage,
  expected: ReleaseExpectation,
): string[] {
  const name = String(packed.manifest.name);
  const problems: string[] = [];
  const audit: Audit = {
    packed,
    expected,
    name,
    fail: (message) => problems.push(`${name}: ${message}`),
  };
  const declared = auditManifest(audit);
  auditFiles(audit);
  auditImports(audit, declared);
  return problems;
}

/** Values the repository owner still has to decide before a real publish. */
export function pendingOwnerDecisions(
  manifest: Record<string, unknown>,
): string[] {
  const pending: string[] = [];
  // Only `private: true` stops a publish; a manifest without it is publishable as it stands.
  pending.push(
    manifest.private === true
      ? "private is true"
      : "private is not set, so the package is publishable as is",
  );
  if (manifest.license === "UNLICENSED" || manifest.license === undefined) {
    pending.push("license is not decided");
  }
  if (manifest.publishConfig === undefined) {
    pending.push("publishConfig is not set");
  }
  return pending;
}

async function run(command: string[], cwd: string): Promise<string> {
  const child = Bun.spawn(command, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) {
    throw new Error(`${command.join(" ")} failed: ${err}`);
  }
  return out;
}

async function listFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, {
    recursive: true,
    withFileTypes: true,
  });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) =>
      relative(root, resolve(entry.parentPath, entry.name)).replaceAll(
        "\\",
        "/",
      ),
    );
}

/**
 * Extract one tarball into `target` and read it back. The archive is named relative to its own
 * directory so a Windows drive letter is never taken for a remote host by GNU tar, and the
 * extracted tree gives one listing whatever prefix the tar implementation prints.
 */
async function readTarball(
  path: string,
  target: string,
): Promise<PackedPackage> {
  await mkdir(target);
  await run(
    [
      "tar",
      "-xzf",
      basename(path),
      "-C",
      target,
    ],
    dirname(path),
  );
  const root = resolve(target, "package");
  const files = await listFiles(root);
  // Shipped code is scanned for imports; the CLI tarball bundles the whole framework and declares it differently.
  const sources = new Map<string, string>();
  for (const file of files) {
    const shipped = file.startsWith("src/") || file.startsWith("dist/");
    if (shipped && SOURCE_FILE_PATTERN.test(file)) {
      sources.set(file, await readFile(resolve(root, file), "utf8"));
    }
  }
  return {
    files,
    manifest: JSON.parse(await readFile(resolve(root, "package.json"), "utf8")),
    sources,
  };
}

async function main(): Promise<number> {
  const info = await release();
  const expected: ReleaseExpectation = {
    version: info.version,
    names: new Set([
      ...Object.values(info.packages),
      ...Object.values(info.plugins),
    ]),
  };
  const directory = await realpath(
    await mkdtemp(resolve(tmpdir(), "bunaway-release-check-")),
  );
  const problems: string[] = [];
  const pending = new Map<string, string[]>();
  try {
    await packFramework(directory);
    for (const name of expected.names) {
      const packed = await readTarball(
        resolve(directory, packageFilename(name, info.version)),
        resolve(
          directory,
          `extract-${basename(packageFilename(name, info.version), ".tgz")}`,
        ),
      );
      if (packed.manifest.name !== name) {
        problems.push(
          `${name}: tarball holds the package ${String(packed.manifest.name)}`,
        );
      }
      problems.push(...auditPackedPackage(packed, expected));
      pending.set(name, pendingOwnerDecisions(packed.manifest));
    }
  } finally {
    await rm(directory, {
      recursive: true,
      force: true,
    });
  }
  const pendingCounts = new Map<string, number>();
  for (const items of pending.values()) {
    for (const item of items) {
      pendingCounts.set(item, (pendingCounts.get(item) ?? 0) + 1);
    }
  }
  for (const [item, count] of pendingCounts) {
    console.log(`pending owner decision: ${item} in ${count} packages`);
  }
  for (const problem of problems) {
    console.error(problem);
  }
  console.log(
    `${expected.names.size} packages checked, ${problems.length} problems.`,
  );
  return problems.length === 0 ? 0 : 1;
}

if (import.meta.main) {
  process.exit(await main());
}
