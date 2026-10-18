import { expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

const repository = resolve(import.meta.dir, "../..");

type PackageManifest = {
  name: string;
  devDependencies?: Record<string, string>;
  workspaces?: string[];
};

type FrameworkRelease = {
  packages: Record<string, string>;
  plugins: Record<string, string>;
};

async function manifest(path: string): Promise<PackageManifest> {
  return (await Bun.file(resolve(repository, path)).json()) as PackageManifest;
}

async function workspaceDirectories(parent: string): Promise<string[]> {
  const entries = await readdir(resolve(repository, parent), {
    withFileTypes: true,
  });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/** Directory name to package name for every workspace under `parent`. */
async function workspaceNames(parent: string): Promise<Record<string, string>> {
  const names: Record<string, string> = {};
  for (const directory of await workspaceDirectories(parent)) {
    names[directory] = (
      await manifest(`${parent}/${directory}/package.json`)
    ).name;
  }
  return names;
}

function sorted(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(record).sort(([a], [b]) => a.localeCompare(b)),
  );
}

test("framework.json lists exactly the package and plugin workspaces", async () => {
  const release = (await Bun.file(
    resolve(repository, "framework.json"),
  ).json()) as FrameworkRelease;
  // A plugin missing here is silently skipped by the plugin build, the framework pack and
  // the documentation reference check.
  expect(sorted(release.plugins)).toEqual(await workspaceNames("plugins"));
  expect(sorted(release.packages)).toEqual(await workspaceNames("packages"));
});

test("the root manifest depends on every package and plugin workspace and nothing else", async () => {
  const root = await manifest("package.json");
  expect(root.workspaces).toEqual(
    expect.arrayContaining([
      "packages/*",
      "plugins/*",
    ]),
  );
  const expected = [
    ...Object.values(await workspaceNames("packages")),
    ...Object.values(await workspaceNames("plugins")),
  ].sort();
  const declared = Object.entries(root.devDependencies ?? {}).filter(([name]) =>
    name.startsWith("@bunaway/"),
  );
  expect(declared.map(([name]) => name).sort()).toEqual(expected);
  for (const [name, version] of declared) {
    expect(`${name}@${version}`).toBe(`${name}@workspace:*`);
  }
});
