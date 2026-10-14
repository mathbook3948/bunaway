import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { captureNativeChild } from "../fixtures/native-child-diagnostics.ts";

const roots: string[] = [];
/** The inherited-pipe regression owns this descendant; it may already have exited during cleanup. */
function stopFixtureDescendant(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (
      !(error instanceof Error && "code" in error && error.code === "ESRCH")
    ) {
      throw error;
    }
  }
}
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
  "native child diagnostics reject a deadline even after a graceful zero exit",
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
    try {
      while (!(await Bun.file(ready).exists())) {
        expect(child.exitCode).toBeNull();
        await Bun.sleep(5);
      }
      const error = await captureNativeChild(
        child,
        root,
        "report pending",
        50,
      ).then(
        () => null,
        (error: unknown) => error,
      );
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toContain(
        "Native fixture deadline expired before completion: report pending",
      );
      expect(await child.exited).toBe(0);
      expect(await Bun.file(resolve(root, "child.json")).json()).toMatchObject({
        phase: "report pending",
        exitCode: 0,
        timedOut: true,
        timeoutMs: 50,
      });
    } finally {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
      await child.exited;
    }
  },
);

test.skipIf(process.platform === "win32")(
  "native child diagnostics force termination when SIGTERM is ignored",
  async () => {
    const root = await mkdtemp(resolve(tmpdir(), "bunaway-child-stuck-"));
    roots.push(root);
    const ready = resolve(root, "ready");
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        "-e",
        `process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); await Bun.write(${JSON.stringify(ready)}, "ready"); await Bun.write(Bun.stdout, "before termination");`,
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
        timeout: 8000,
        killSignal: "SIGKILL",
      },
    );
    try {
      while (!(await Bun.file(ready).exists())) {
        expect(child.exitCode).toBeNull();
        await Bun.sleep(5);
      }
      await expect(
        captureNativeChild(child, root, "stuck child", 50),
      ).rejects.toThrow(
        "Native fixture deadline expired before completion: stuck child",
      );
      expect(child.signalCode).toBe("SIGKILL");
      expect(await readFile(resolve(root, "stdout.log"), "utf8")).toBe(
        "before termination",
      );
      expect(await Bun.file(resolve(root, "child.json")).json()).toMatchObject({
        phase: "stuck child",
        timedOut: true,
        forcedTermination: true,
        timeoutMs: 50,
      });
    } finally {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
      await child.exited;
    }
  },
  10_000,
);

test.skipIf(process.platform === "win32")(
  "native child diagnostics bound inherited pipes after a zero exit and retain captured bytes",
  async () => {
    const root = await mkdtemp(resolve(tmpdir(), "bunaway-child-pipe-owner-"));
    roots.push(root);
    const ready = resolve(root, "ready");
    const descendantSource = `await Bun.write(${JSON.stringify(ready)}, String(process.pid)); setInterval(() => {}, 1000); setTimeout(() => process.exit(0), 8000);`;
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        "-e",
        `Bun.spawn([process.execPath, "--no-env-file", "-e", ${JSON.stringify(descendantSource)}], {stdin: "ignore", stdout: "inherit", stderr: "inherit"}); while (!(await Bun.file(${JSON.stringify(ready)}).exists())) await Bun.sleep(5); await Bun.write(Bun.stdout, Buffer.from([65,255,66])); process.exit(0);`,
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
        timeout: 8000,
        killSignal: "SIGKILL",
      },
    );
    try {
      // The parent has exited, but its owned descendant still holds both write ends.
      expect(await child.exited).toBe(0);
      await expect(
        captureNativeChild(child, root, "inherited pipes", 50),
      ).rejects.toThrow(
        "Native fixture deadline expired before completion: inherited pipes",
      );
      expect(await readFile(resolve(root, "stdout.log"))).toEqual(
        Buffer.from([
          65,
          255,
          66,
        ]),
      );
      expect(await Bun.file(resolve(root, "child.json")).json()).toMatchObject({
        phase: "inherited pipes",
        exitCode: 0,
        timedOut: true,
        forcedTermination: false,
        outputTruncated: true,
        cancellationErrors: [],
      });
    } finally {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
      await child.exited;
      if (await Bun.file(ready).exists()) {
        const pid = Number(await Bun.file(ready).text());
        expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
        stopFixtureDescendant(pid);
      }
    }
  },
  10_000,
);
