import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import {
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import {
  acquireBuildOutputLock,
  acquirePackageInputLock,
  type BuildTarget,
  ownedDirectory,
} from "../../packages/packaging/src/index.ts";

let home: string;
beforeAll(async () => {
  home = await realpath(await mkdtemp(resolve(tmpdir(), "bunaway-output-boundaries-")));
});
afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

test("owned directories reject escapes and files and create only regular descendants", async () => {
  const root = resolve(home, "regular");
  await mkdir(root);
  expect(await ownedDirectory(root, resolve(root, "dist/nested"))).toBe(false);
  expect(await ownedDirectory(root, resolve(root, "dist/nested"), true)).toBe(true);
  await expect(ownedDirectory(root, home, true)).rejects.toThrow("escapes");
  await writeFile(resolve(root, "file"), "sentinel");
  await expect(ownedDirectory(root, resolve(root, "file/nested"), true)).rejects.toThrow(
    "without links",
  );
});

test("lock entry points reject unknown and traversal targets before creating directories", async () => {
  const root = resolve(home, "invalid-target");
  await mkdir(root);
  for (const target of ["windows-arm64", "windows-x64/../../escape", "../escape"]) {
    await expect(acquireBuildOutputLock(root, target as BuildTarget)).rejects.toThrow(
      "Unsupported",
    );
    await expect(acquirePackageInputLock(root, target as BuildTarget)).rejects.toThrow(
      "Unsupported",
    );
  }
  expect(await readdir(root)).toEqual([]);
});

test("a linked project root cannot redirect output creation", async () => {
  const external = await mkdtemp(resolve(home, "external-root-"));
  const root = resolve(home, `root-link-${crypto.randomUUID()}`);
  await symlink(external, root, "junction");
  await expect(ownedDirectory(root, resolve(root, "dist/nested"), true)).rejects.toThrow(
    "without links",
  );
  expect(await readdir(external)).toEqual([]);
});

for (const internal of [false, true]) {
  for (const part of ["dist", "dist/windows-x64", "dist/windows-x64/packaged"]) {
    test(`owned directories reject ${part} links (${internal ? "internal" : "external"})`, async () => {
      const root = await mkdtemp(resolve(home, "directory-"));
      const destination = internal
        ? resolve(root, "redirected")
        : await mkdtemp(resolve(home, "external-"));
      await mkdir(destination, { recursive: true });
      const link = resolve(root, part);
      await mkdir(resolve(link, ".."), { recursive: true });
      await symlink(destination, link, "junction");
      await expect(ownedDirectory(root, resolve(link, "new/nested"), true)).rejects.toThrow(
        "without links",
      );
      expect(await readdir(destination)).toEqual([]);
    });
  }
}

for (const part of ["dist", "dist/.bunaway-locks", "dist/.bunaway-locks/windows-x64"]) {
  test(`both lock entry points reject ${part} links without touching their targets`, async () => {
    const root = await mkdtemp(resolve(home, "locks-"));
    const external = await mkdtemp(resolve(home, "external-locks-"));
    const path = resolve(root, part);
    await mkdir(resolve(path, ".."), { recursive: true });
    await symlink(external, path, "junction");
    await expect(acquireBuildOutputLock(root, "windows-x64")).rejects.toThrow("without links");
    await expect(acquirePackageInputLock(root, "windows-x64")).rejects.toThrow("without links");
    expect(await readdir(external)).toEqual([]);
  });
}

for (const acquire of [acquireBuildOutputLock, acquirePackageInputLock]) {
  test(`${acquire.name} release refuses a redirected parent without deleting external files`, async () => {
    const root = await mkdtemp(resolve(home, "release-"));
    const directory = resolve(root, "dist/.bunaway-locks/windows-x64");
    const saved = resolve(root, "saved-locks");
    const external = await mkdtemp(resolve(home, "external-release-"));
    const originalOpen = fs.open;
    let name = "";
    const opening = spyOn(fs, "open").mockImplementation(async (...args) => {
      const file = await originalOpen(...args);
      const close = file.close.bind(file);
      name = basename(String(args[0]));
      // Redirect after close, when Windows also permits moving the directory.
      file.close = async () => {
        await close();
        await writeFile(resolve(external, name), "external lock bytes");
        await rename(directory, saved);
        await symlink(external, directory, "junction");
      };
      return file;
    });
    try {
      const release = await acquire(root, "windows-x64");
      await expect(release()).rejects.toThrow("without links");
      expect(await Bun.file(resolve(external, name)).text()).toBe("external lock bytes");
      expect(await readdir(external)).toEqual([name]);
    } finally {
      opening.mockRestore();
      await unlink(directory);
      await rename(saved, directory);
    }
  });
}
