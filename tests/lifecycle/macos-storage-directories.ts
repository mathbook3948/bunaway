import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { BunawayError } from "@bunaway/plugin";
import type { MacosStorage } from "../../plugins/storage/src/platforms/macos.ts";
import { executeMacosStorage } from "../fixtures/macos-storage-operations.ts";

/** Exercise real directories and creation contracts in the caller's owned temporary root. */
export function verifyMacosDirectories(
  storage: MacosStorage,
  root: string,
): string[] {
  const directory = `${root}/directories`;
  const create = (path: string, recursive = false) =>
    storage.createDirectory({
      path,
      recursive,
    });
  const list = (path: string) =>
    executeMacosStorage(storage, "storage.readDirectory", {
      path,
    });
  const denied = (action: () => unknown, code: string) =>
    assert.throws(
      action,
      (error) => error instanceof BunawayError && error.code === code,
    );
  assert.equal(create(directory), null);
  assert.equal(create(directory), null);
  assert.deepEqual(list(directory), []);
  assert.equal(statSync(directory).mode & 0o777, 0o700);
  const names = [
    "한글🙂.txt",
    "\uE000.txt",
    "🙂.txt",
    "A.txt",
    "z.txt",
  ];
  for (const name of names) {
    writeFileSync(`${directory}/${name}`, "inside");
  }
  mkdirSync(`${directory}/folder`);
  writeFileSync(`${directory}/folder/hidden`, "not a direct child");
  symlinkSync(`${root}/absent`, `${directory}/dangling`);
  symlinkSync(`${root}/outside`, `${directory}/link`);
  linkSync(`${directory}/A.txt`, `${directory}/hardlink`);
  assert.deepEqual(
    list(directory),
    [
      ...names.map((name) => ({
        name,
        kind: "file",
      })),
      {
        name: "folder",
        kind: "directory",
      },
      {
        name: "dangling",
        kind: "link",
      },
      {
        name: "link",
        kind: "link",
      },
      {
        name: "hardlink",
        kind: "file",
      },
    ].sort((left, right) =>
      left.name < right.name ? -1 : Number(left.name > right.name),
    ),
  );
  const limit = `${root}/entry-limit`;
  create(limit);
  for (let i = 0; i < 256; i++) {
    writeFileSync(`${limit}/${i.toString().padStart(3, "0")}`, "");
  }
  const bounded = list(limit);
  assert(Array.isArray(bounded) && bounded.length === 256);
  writeFileSync(`${limit}/extra`, "");
  denied(() => list(limit), "INVALID_ARGUMENT");
  const special = `${root}/special-entry`;
  create(special);
  execFileSync("/usr/bin/mkfifo", [
    `${special}/fifo`,
  ]);
  denied(() => list(special), "UNSUPPORTED");
  denied(() => create(`${root}/missing-default/child`), "INVALID_ARGUMENT");
  assert.equal(existsSync(`${root}/missing-default`), false);
  assert.equal(create(`${root}/created/parent/child`, true), null);
  assert.equal(create(`${root}/created/parent/child`, false), null);
  for (const path of [
    `${root}/created`,
    `${root}/created/parent`,
    `${root}/created/parent/child`,
  ]) {
    assert.equal(statSync(path).mode & 0o777, 0o700);
  }
  writeFileSync(`${root}/plain-file`, "preserved");
  denied(() => create(`${root}/plain-file`), "INVALID_ARGUMENT");
  denied(() => list(`${root}/plain-file`), "INVALID_ARGUMENT");
  denied(() => list(`${root}/missing-list`), "INVALID_ARGUMENT");
  denied(() => create(`${root}/plain-file/child`, true), "INVALID_ARGUMENT");
  // Links are followed like any path: a link to a directory lists and extends it, a dangling one is absent.
  symlinkSync(directory, `${root}/directory-link`);
  assert(Array.isArray(list(`${root}/directory-link`)));
  assert.equal(create(`${root}/directory-link`), null);
  denied(() => list(`${directory}/dangling`), "INVALID_ARGUMENT");
  denied(() => create(`${directory}/dangling`), "INVALID_ARGUMENT");
  assert.equal(create(`${root}/directory-link/child`, true), null);
  assert.equal(existsSync(`${directory}/child`), true);
  const privateDirectory = `${root}/private-directory`;
  create(privateDirectory);
  chmodSync(privateDirectory, 0);
  try {
    denied(() => list(privateDirectory), "PERMISSION_DENIED");
    assert.equal(create(privateDirectory), null);
  } finally {
    chmodSync(privateDirectory, 0o700);
  }
  const remove = (path: string) =>
    executeMacosStorage(storage, "storage.remove", {
      path,
    });
  denied(() => remove(directory), "INVALID_ARGUMENT");
  denied(() => remove(`${root}/missing-remove`), "INVALID_ARGUMENT");
  assert.equal(existsSync(directory), true);
  // A file, a link (not its target) and an empty directory are removed.
  assert.equal(remove(`${root}/plain-file`), null);
  assert.equal(existsSync(`${root}/plain-file`), false);
  assert.equal(remove(`${directory}/link`), null);
  assert.equal(remove(`${directory}/dangling`), null);
  assert.equal(remove(`${root}/directory-link`), null);
  assert.equal(existsSync(directory), true);
  assert.equal(remove(`${directory}/child`), null);
  assert.equal(existsSync(`${directory}/child`), false);
  return [
    "directory listing, UTF-16 ordering, observed links and hardlinks, direct children and exact 256-entry bound",
    "default nonrecursive and recursive private directory creation, idempotence, missing parents, type, links and an unreadable directory",
    "unknown and special directory kinds fail closed; links are followed, remove deletes files, links and empty directories only",
  ];
}
