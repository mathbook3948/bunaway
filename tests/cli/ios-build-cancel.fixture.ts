// Run against the installed CLI in isolation, retaining real Xcode, copy and publication work.
import { spyOn } from "bun:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { acquireBuildOutputLock } from "@bunaway/packaging";
import { outputPaths } from "@bunaway/packaging/paths";

const root = process.argv[2];
assert(root);
const installed = resolve(root, "node_modules/@bunaway/cli/packages/cli/src");
const files: typeof import("#cli/files") = await import(
  resolve(installed, "files.ts")
);
const { buildIosProject }: typeof import("#cli/ios") = await import(
  resolve(installed, "ios.ts")
);
const paths = outputPaths(root, "ios");
const manifestPath = resolve(paths.output, "manifest.json");
const previousManifest = await readFile(manifestPath, "utf8");
const marker = resolve(paths.output, "previous-output.txt");
await writeFile(marker, "keep previous output");
const hash = files.hash;
let interrupted = false;
const hashing = spyOn(files, "hash").mockImplementation(async (path) => {
  const digest = await hash(path);
  if (path.endsWith(`${sep}output${sep}Bunaway.app${sep}Bunaway`)) {
    interrupted = true;
    const received = once(process, "SIGINT");
    process.kill(process.pid, "SIGINT");
    await received;
  }
  return digest;
});
try {
  await assert.rejects(buildIosProject(root), /iOS build cancelled/);
  assert(
    interrupted,
    "Cancellation must occur after the app copy, during output hashing",
  );
  assert.equal(await readFile(marker, "utf8"), "keep previous output");
  assert.equal(await readFile(manifestPath, "utf8"), previousManifest);
  assert.deepEqual(await readdir(paths.work), []);
  const release = await acquireBuildOutputLock(root, "ios");
  await release();
  console.log(
    "PASS: cancelled iOS build preserves output and releases staging and lock",
  );
} finally {
  hashing.mockRestore();
  await rm(marker, {
    force: true,
  });
}
