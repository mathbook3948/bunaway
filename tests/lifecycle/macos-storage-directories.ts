import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { BunawayError } from "@bunaway/plugin";
import type { MacosStorage } from "../../plugins/storage/src/platforms/macos.ts";

/** Exercise real directory descriptors and creation contracts in the caller's owned temporary root. */
export function verifyMacosDirectories(
  storage: MacosStorage,
  root: string,
): string[] {
  const directory = `${root}/directories`;
  const create = (path: string, recursive?: boolean) =>
    storage.execute(
      "storage.createDirectory",
      recursive === undefined
        ? {
            path,
          }
        : {
            path,
            recursive,
          },
    );
  const list = (path: string) =>
    storage.execute("storage.readDirectory", {
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
  denied(() => create(`${root}/plain-file/child`, true), "PERMISSION_DENIED");
  symlinkSync(directory, `${root}/directory-link`);
  for (const path of [
    `${root}/directory-link`,
    `${directory}/dangling`,
  ]) {
    denied(() => list(path), "PERMISSION_DENIED");
    denied(() => create(path), "PERMISSION_DENIED");
  }
  denied(
    () => create(`${root}/directory-link/child`, true),
    "PERMISSION_DENIED",
  );
  assert.equal(existsSync(`${directory}/child`), false);
  const privateDirectory = `${root}/private-directory`;
  create(privateDirectory);
  chmodSync(privateDirectory, 0);
  try {
    denied(() => list(privateDirectory), "PERMISSION_DENIED");
    denied(() => create(privateDirectory), "PERMISSION_DENIED");
  } finally {
    chmodSync(privateDirectory, 0o700);
  }
  for (const path of [
    directory,
    `${root}/plain-file`,
    `${root}/missing-remove`,
    `${directory}/dangling`,
  ]) {
    denied(
      () =>
        storage.execute("storage.remove", {
          path,
        }),
      "UNSUPPORTED",
    );
  }
  assert.equal(existsSync(directory), true);
  assert.equal(existsSync(`${root}/plain-file`), true);
  return [
    "checked directory streams, UTF-16 ordering, observed links and hardlinks, direct children and exact 256-entry bound",
    "default nonrecursive and recursive private directory creation, idempotence, missing parents, type, links and OS denials",
    "unknown and special directory kinds fail closed; unsupported remove preserves existing objects",
  ];
}
