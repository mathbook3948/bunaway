import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BunawayError } from "@bunaway/protocol";
import { runProcess } from "#plugins/process/src/run";
import { processExitProbe } from "../fixtures/process-exit-probe.ts";

const defaults = {
  executablePath: process.execPath,
  args: [],
  maxOutputBytes: 65536,
  timeoutMs: 30000,
};

test("argv invocation preserves special arguments, binary stdin/stdout/stderr and nonzero completion", async () => {
  const args = [
    "",
    "한글 😀",
    'quote"value',
    "trail\\",
    "a & b",
    "%PATH%",
    "$(echo unsafe)",
  ];
  const script =
    "const bytes = await Bun.stdin.arrayBuffer(); process.stdout.write(Buffer.from(bytes)); process.stderr.write(JSON.stringify(process.argv.slice(1))); process.exitCode = 17;";
  const result = await runProcess(
    {
      ...defaults,
      args: [
        "-e",
        script,
        ...args,
      ],
      stdinBase64: "AP8BCg==",
    },
    new AbortController().signal,
  );
  expect(result.pid).toBeGreaterThan(0);
  expect(result.exitCode).toBe(17);
  expect(result.signal).toBeNull();
  expect(result.stdoutBase64).toBe("AP8BCg==");
  expect(
    JSON.parse(Buffer.from(result.stderrBase64, "base64").toString()),
  ).toEqual(args);
});

test("stdout and stderr share a bounded output budget; exact limit and empty output succeed", async () => {
  const signal = new AbortController().signal;
  const output = await runProcess(
    {
      ...defaults,
      maxOutputBytes: 8,
      args: [
        "-e",
        'process.stdout.write("abcd"); process.stderr.write("efgh");',
      ],
    },
    signal,
  );
  expect(
    Buffer.from(output.stdoutBase64, "base64").length +
      Buffer.from(output.stderrBase64, "base64").length,
  ).toBe(8);
  await expect(
    runProcess(
      {
        ...defaults,
        maxOutputBytes: 7,
        args: [
          "-e",
          'process.stdout.write("abcd"); process.stderr.write("efgh");',
        ],
      },
      signal,
    ),
  ).rejects.toMatchObject({
    code: "INTERNAL",
  });
  expect(
    (
      await runProcess(
        {
          ...defaults,
          maxOutputBytes: 0,
          args: [
            "-e",
            "void 0;",
          ],
        },
        signal,
      )
    ).stdoutBase64,
  ).toBe("");
  await expect(
    runProcess(
      {
        ...defaults,
        maxOutputBytes: 0,
        args: [
          "-e",
          'process.stdout.write("x"); setInterval(() => {}, 1000);',
        ],
      },
      signal,
    ),
  ).rejects.toMatchObject({
    code: "INTERNAL",
  });
});

test("cancellation waits for direct-child death and closes blocked output pipes", async () => {
  const root = await mkdtemp(join(tmpdir(), "bunaway-process-"));
  const controller = new AbortController();
  let observed: Promise<unknown> | undefined;
  try {
    const pidFile = join(root, "pid");
    const pending = runProcess(
      {
        ...defaults,
        args: [
          resolve(import.meta.dir, "../fixtures/process-ready.ts"),
          pidFile,
        ],
      },
      controller.signal,
    );
    observed = pending.catch((error: unknown) => error);
    const deadline = Date.now() + 2000;
    while (!(await Bun.file(pidFile).exists())) {
      expect(Date.now()).toBeLessThan(deadline);
      await Bun.sleep(2);
    }
    const pid = Number(await readFile(pidFile, "utf8"));
    const probe = processExitProbe(pid);
    try {
      expect(probe.exited()).toBe(false);
      controller.abort(
        new BunawayError({
          code: "CANCELLED",
          message: "Test request ended.",
        }),
      );
      expect(await observed).toMatchObject({
        code: "CANCELLED",
      });
      // The held Windows handle must already be signaled when runProcess returns, without a grace poll.
      expect(probe.exited()).toBe(true);
    } finally {
      probe.dispose();
    }
  } finally {
    // A setup/assertion failure must still stop the child and observe its owned task.
    controller.abort();
    await observed;
    await rm(root, {
      recursive: true,
      force: true,
    });
  }
});
