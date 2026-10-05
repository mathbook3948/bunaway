import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  acquireBuildOutputLock,
  acquirePackageInputLock,
} from "../../packages/packaging/src/index.ts";

let home: string;
beforeAll(async () => {
  home = await fs.realpath(await fs.mkdtemp(resolve(tmpdir(), "bunaway-target-locks-")));
});
afterAll(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

test("parallel package readers exclude rebuilds until all readers release", async () => {
  const root = resolve(home, "readers");
  const [first, second] = await Promise.all([
    acquirePackageInputLock(root, "windows-x64"),
    acquirePackageInputLock(root, "windows-x64"),
  ]);
  await expect(acquireBuildOutputLock(root, "windows-x64")).rejects.toThrow("packaging");
  await first();
  await expect(acquireBuildOutputLock(root, "windows-x64")).rejects.toThrow("packaging");
  await second();
  const build = await acquireBuildOutputLock(root, "windows-x64");
  try {
    await expect(acquirePackageInputLock(root, "windows-x64")).rejects.toThrow("rebuild");
    await expect(acquireBuildOutputLock(root, "windows-x64")).rejects.toThrow("rebuild");
    const mac = await acquireBuildOutputLock(root, "macos-arm64");
    await mac();
  } finally {
    await build();
  }
  const reader = await acquirePackageInputLock(root, "windows-x64");
  await reader();
  expect(await fs.readdir(resolve(root, "dist/.bunaway-locks/windows-x64"))).toEqual([]);
});

test("a reader rechecks a rebuild that starts during registration", async () => {
  const root = resolve(home, "registration-race");
  const originalOpen = fs.open;
  let releaseBuild: (() => Promise<void>) | undefined;
  const registration = spyOn(fs, "open").mockImplementation(async (path, ...args) => {
    if (String(path).includes("package-")) {
      releaseBuild = await acquireBuildOutputLock(root, "windows-x64");
    }
    return originalOpen(path, ...args);
  });
  try {
    await expect(acquirePackageInputLock(root, "windows-x64")).rejects.toThrow("rebuild");
    expect(await fs.readdir(resolve(root, "dist/.bunaway-locks/windows-x64"))).toEqual([
      "build.lock",
    ]);
  } finally {
    registration.mockRestore();
    await releaseBuild?.();
  }
});

test("a rebuild observes a reader registered before its second lock check", async () => {
  const root = resolve(home, "reader-first-race");
  const originalOpen = fs.open;
  let checked = false;
  const recheck = spyOn(fs, "open").mockImplementation(async (path, ...args) => {
    const file = await originalOpen(path, ...args);
    if (String(path).includes("package-")) {
      await expect(acquireBuildOutputLock(root, "windows-x64")).rejects.toThrow("packaging");
      checked = true;
    }
    return file;
  });
  let release: (() => Promise<void>) | undefined;
  try {
    release = await acquirePackageInputLock(root, "windows-x64");
    expect(checked).toBe(true);
  } finally {
    recheck.mockRestore();
    await release?.();
  }
});

test("package input locks coordinate with rebuilds across processes", async () => {
  const root = resolve(home, "child-reader");
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `import { acquirePackageInputLock } from ${JSON.stringify(import.meta.resolve("../../packages/packaging/src/index.ts"))};
const release = await acquirePackageInputLock(process.argv[1], "windows-x64");
console.log("ready");
for await (const chunk of Bun.stdin.stream()) { break; }
await release();`,
      root,
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
  try {
    const ready = child.stdout.getReader();
    expect(new TextDecoder().decode((await ready.read()).value)).toContain("ready");
    ready.releaseLock();
    await expect(acquireBuildOutputLock(root, "windows-x64")).rejects.toThrow("packaging");
    child.stdin.write("release\n");
    child.stdin.end();
    expect(await child.exited).toBe(0);
    const release = await acquireBuildOutputLock(root, "windows-x64");
    await release();
  } finally {
    child.kill();
    await child.exited;
  }
}, 10000);
