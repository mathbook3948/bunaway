import { constants, type Stats } from "node:fs";
import { copyFile, lstat, mkdir } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { OUTPUT_TARGETS, outputPaths } from "@bunaway/packaging/paths";
import { isWindowsFileName } from "@bunaway/protocol";
import { files, inside } from "./files.ts";

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

/** The `~N` marker of an NTFS 8.3 short name. */
const SHORT_NAME_ALIAS = /~\d/;

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
    // NTFS 8.3 aliases (WEBVIE~1.DLL, BUNAWA~1) name the same file as a longer name this check cannot compare.
    if (parts.some((part) => SHORT_NAME_ALIAS.test(part))) {
      throw new Error(
        `bunaway.json: build.resources entry ${JSON.stringify(entry)} has a segment with '~' followed by a digit, which can alias a Windows 8.3 short name; rename the file.`,
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

/** One validated file to copy: an absolute source in the project and its destination in the package directory. */
export interface PlannedResource {
  source: string;
  target: string;
}

/** Lstat that reports a missing path as undefined and keeps every other failure, with the entry named. */
async function lstatEntry(path: string, entry: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw new Error(`build.resources entry ${entry} cannot be read.`, {
      cause: error,
    });
  }
}

/** Reject a link at any segment of the entry, so the path read is the path declared. */
async function assertNoLinks(
  projectRoot: string,
  entry: string,
): Promise<Stats> {
  let current = projectRoot;
  let info: Stats | undefined;
  for (const part of entry.split("/")) {
    current = resolve(current, part);
    info = await lstatEntry(current, entry);
    if (!info || info.isSymbolicLink()) {
      throw new Error(
        `build.resources entry ${entry} must be an existing regular file or directory reached without links.`,
      );
    }
  }
  if (!info || !(info.isFile() || info.isDirectory())) {
    throw new Error(
      `build.resources entry ${entry} must be a regular file or a directory.`,
    );
  }
  return info;
}

/**
 * Validate every declared source before the build starts compiling and list the
 * files to copy. Sources must be regular files or directories of regular files
 * inside the project; links at any level, special files, build output and the app
 * executable name are rejected rather than followed.
 */
export async function planBuildResources(
  projectRoot: string,
  packageRoot: string,
  entries: readonly string[],
  executableName: string,
): Promise<PlannedResource[]> {
  const outputs = [
    ".bunaway",
    ...OUTPUT_TARGETS.map((target) => outputPaths(projectRoot, target).output),
  ].map((path) => resolve(projectRoot, path).toLowerCase());
  const planned: PlannedResource[] = [];
  for (const entry of entries) {
    if (entry.split("/")[0]?.toLowerCase() === executableName.toLowerCase()) {
      throw new Error(
        `build.resources entry ${entry} would replace the app executable.`,
      );
    }
    const source = resolve(projectRoot, entry);
    const lower = source.toLowerCase();
    if (outputs.some((out) => inside(out, lower) || inside(lower, out))) {
      throw new Error(
        `build.resources entry ${entry} must not overlap app outputs or build locks.`,
      );
    }
    const info = await assertNoLinks(projectRoot, entry);
    // files() rejects links and special files below a directory entry.
    const sources = info.isDirectory()
      ? await files(source)
      : [
          source,
        ];
    for (const file of sources) {
      planned.push({
        source: file,
        target: info.isDirectory()
          ? resolve(packageRoot, entry, relative(source, file))
          : resolve(packageRoot, entry),
      });
    }
  }
  return planned;
}

/**
 * Copy the files of a plan into the staged package directory. An existing
 * destination fails the build instead of being replaced, so a resource can never
 * overwrite the compiled host, the loader or another resource.
 */
export async function copyBuildResources(
  planned: readonly PlannedResource[],
): Promise<void> {
  for (const { source, target } of planned) {
    await mkdir(dirname(target), {
      recursive: true,
    });
    try {
      await copyFile(source, target, constants.COPYFILE_EXCL);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(
          `build.resources would overwrite an existing package file: ${relative(dirname(target), target)}.`,
          {
            cause: error,
          },
        );
      }
      throw error;
    }
  }
}
