import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { captureNativeChild } from "../fixtures/native-child-diagnostics.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, {
      recursive: true,
      force: true,
    });
  }
});

/** Exercise real pipes, including bytes that PowerShell would treat as malformed CLIXML. */
async function launch(exitCode: number, size: number) {
  const root = await mkdtemp(resolve(tmpdir(), "bunaway-child-diagnostics-"));
  roots.push(root);
  const stdout = Buffer.alloc(size, 65);
  const stderr = Buffer.concat([
    Buffer.from("#< CLIXML\r\n"),
    Buffer.from([
      0,
      255,
      27,
    ]),
    Buffer.alloc(size, 66),
  ]);
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "-e",
      `await Bun.write(Bun.stdout, Buffer.alloc(${size}, 65)); await Bun.write(Bun.stderr, Buffer.concat([Buffer.from("#< CLIXML\\r\\n"), Buffer.from([0, 255, 27]), Buffer.alloc(${size}, 66)])); process.exit(${exitCode});`,
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const result = await captureNativeChild(child, root, "report pending");
  expect(await readFile(resolve(root, "stdout.log"))).toEqual(stdout);
  expect(await readFile(resolve(root, "stderr.log"))).toEqual(stderr);
  const metadata = await Bun.file(resolve(root, "child.json")).json();
  expect(metadata).toMatchObject({
    phase: "report pending",
    pid: child.pid,
    exitCode,
  });
  expect(metadata.elapsedMs).toBeGreaterThanOrEqual(0);
  expect(result.exitCode).toBe(exitCode);
  return root;
}

test("native child diagnostics retain raw output even when the child exits successfully", async () => {
  const root = await launch(0, 16);
  expect(await Bun.file(resolve(root, "report.json")).exists()).toBe(false);
});

test("native child diagnostics drain both large pipes and preserve a failing exit", async () => {
  // A child waiting on a full pipe must not prevent collection of the other stream or exit.
  await launch(7, 128 * 1024);
});
