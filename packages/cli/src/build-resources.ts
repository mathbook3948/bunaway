import { copyFile, lstat, mkdir } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { OUTPUT_TARGETS, outputPaths } from "@bunaway/packaging/paths";
import { isWindowsFileName } from "@bunaway/protocol";
import { files, inside, projectPath } from "./files.ts";

/** More entries than any app needs; keeps a mistaken generated list from copying a whole tree piecemeal. */
const MAX_RESOURCES = 256;

/** Top-level names the build writes into the package directory itself. */
const RESERVED_NAMES = [
  "assets",
  "licenses",
  "runtime",
  "packaged",
  "manifest.json",
  "webview2loader.dll",
];

function segments(name: string): string[] {
  return name.split(/[\\/]/);
}

/**
 * Validate `build.resources`: project-relative files or directories that are copied
 * to the same relative path under the app resource directory. Entries use the
 * Windows file-name rules so one declaration is valid on every platform, may not
 * shadow files the build owns, and may not repeat or contain one another.
 */
export function parseBuildResources(value: unknown): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    !Array.isArray(value) ||
    value.length > MAX_RESOURCES ||
    value.some((entry) => typeof entry !== "string")
  ) {
    throw new Error(
      `bunaway.json: build.resources must be an array of at most ${MAX_RESOURCES} project-relative paths.`,
    );
  }
  const normalized: string[] = [];
  for (const entry of value as string[]) {
    const parts = segments(entry);
    if (!parts.every((part) => isWindowsFileName(part))) {
      throw new Error(
        `bunaway.json: build.resources entry ${JSON.stringify(entry)} must be a relative path without '..', '.', empty segments, drive letters or characters Windows rejects in file names.`,
      );
    }
    if (RESERVED_NAMES.includes(parts[0]?.toLowerCase() ?? "")) {
      throw new Error(
        `bunaway.json: build.resources entry ${JSON.stringify(entry)} starts with a name the build uses for its own files (${RESERVED_NAMES.join(", ")}).`,
      );
    }
    normalized.push(parts.join("/"));
  }
  const folded = normalized.map((entry) => entry.toLowerCase());
  for (const [index, entry] of folded.entries()) {
    const clash = folded.findIndex(
      (other, otherIndex) =>
        otherIndex !== index &&
        (other === entry || entry.startsWith(`${other}/`)),
    );
    if (clash >= 0) {
      throw new Error(
        `bunaway.json: build.resources entry ${JSON.stringify(normalized[index])} duplicates or lies inside ${JSON.stringify(normalized[clash])}.`,
      );
    }
  }
  return normalized;
}

/**
 * Copy the declared files and directories into the staged package directory.
 * Sources must be regular files or directories of regular files inside the
 * project; links, special files and build output are rejected rather than followed.
 */
export async function copyBuildResources(
  projectRoot: string,
  packageRoot: string,
  entries: readonly string[],
  executableName: string,
): Promise<void> {
  const outputs = [
    ".bunaway",
    ...OUTPUT_TARGETS.map((target) => outputPaths(projectRoot, target).output),
  ].map((path) => resolve(projectRoot, path).toLowerCase());
  for (const entry of entries) {
    if (entry.split("/")[0]?.toLowerCase() === executableName.toLowerCase()) {
      throw new Error(
        `build.resources entry ${entry} would replace the app executable.`,
      );
    }
    const lexical = resolve(projectRoot, entry);
    const lower = lexical.toLowerCase();
    if (outputs.some((out) => inside(out, lower) || inside(lower, out))) {
      throw new Error(
        `build.resources entry ${entry} must not overlap app outputs or build locks.`,
      );
    }
    const info = await lstat(lexical).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") {
        throw error;
      }
      return undefined;
    });
    if (
      !info ||
      info.isSymbolicLink() ||
      !(info.isFile() || info.isDirectory())
    ) {
      throw new Error(
        `build.resources entry ${entry} must be an existing regular file or directory, not a link.`,
      );
    }
    // Resolve through any directory link in the parents so the source stays inside the project.
    const source = await projectPath(projectRoot, entry);
    const sources = info.isDirectory()
      ? await files(source)
      : [
          source,
        ];
    for (const file of sources) {
      const target = info.isDirectory()
        ? resolve(packageRoot, entry, relative(source, file))
        : resolve(packageRoot, entry);
      await mkdir(dirname(target), {
        recursive: true,
      });
      await copyFile(file, target);
    }
  }
}
