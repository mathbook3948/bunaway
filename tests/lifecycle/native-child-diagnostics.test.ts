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

test.skipIf(process.platform === "win32")(
  "native child diagnostics reject signal termination even after a graceful zero exit",
  async () => {
    const root = await mkdtemp(resolve(tmpdir(), "bunaway-child-termination-"));
    roots.push(root);
    const ready = resolve(root, "ready");
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        "-e",
        `process.on("SIGTERM", () => process.exit(0)); setInterval(() => {}, 1000); await Bun.write(${JSON.stringify(ready)}, "ready");`,
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
        timeout: 4000,
      },
    );
    // Observe rejection immediately, including if startup fails before the readiness marker.
    const result = captureNativeChild(child, root, "report pending").then(
      () => null,
      (error: unknown) => error,
    );
    try {
      while (!(await Bun.file(ready).exists())) {
        expect(child.exitCode).toBeNull();
        await Bun.sleep(5);
      }
      child.kill("SIGTERM");
      const error = await result;
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toContain(
        "Native fixture was terminated before completion: report pending",
      );
      expect(await child.exited).toBe(0);
      expect(await Bun.file(resolve(root, "child.json")).json()).toMatchObject({
        phase: "report pending",
        exitCode: 0,
        killed: true,
      });
    } finally {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
      await child.exited;
      await result;
    }
  },
);
