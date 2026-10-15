import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { BunawayError } from "@bunaway/protocol";
import {
  dispose,
  initialize,
  run,
} from "#plugins/process/src/platforms/windows";
import { runProcess } from "#plugins/process/src/platforms/windows-process";
import { processExitProbe } from "../fixtures/process-exit-probe.ts";

const defaults = {
  executablePath: process.execPath,
  args: [],
  maxOutputBytes: 65536,
  timeoutMs: 30000,
};

test("argv invocation inherits Bun dotenv values without loading dotenv in the child", async () => {
  const root = await mkdtemp(join(tmpdir(), "bunaway-process-environment-"));
  const key = `BUNAWAY_PROCESS_ENV_${crypto.randomUUID().replaceAll("-", "_")}`;
  const emptyKey = `${key}_EMPTY`;
  const value = "한글 😀 = & spaces";
  expect(process.env[key]).toBeUndefined();
  expect(process.env[emptyKey]).toBeUndefined();
  const runnerModule = pathToFileURL(
    resolve(
      import.meta.dir,
      "../../plugins/process/src/platforms/windows-process.ts",
    ),
  ).href;
  try {
    const envFile = join(root, "runner.env");
    const runnerFile = join(root, "runner.ts");
    await Bun.write(envFile, `${key}=${JSON.stringify(value)}\n${emptyKey}=\n`);
    await Bun.write(
      runnerFile,
      `
      import assert from "node:assert/strict";
      const { runProcess } = await import(${JSON.stringify(runnerModule)});
      assert.equal(process.env[${JSON.stringify(key)}], ${JSON.stringify(value)});
      assert.equal(process.env[${JSON.stringify(emptyKey)}], "");
      if (process.platform === "win32") {
        const { dlopen, ptr } = await import("bun:ffi");
        const api = dlopen("kernel32.dll", {
          GetEnvironmentVariableW: { args: ["ptr", "ptr", "u32"], returns: "u32" },
          GetLastError: { args: [], returns: "u32" },
        });
        try {
          const name = Buffer.from(${JSON.stringify(`${key}\0`)}, "utf16le");
          assert.equal(api.symbols.GetEnvironmentVariableW(ptr(name), null, 0), 0);
          assert.equal(api.symbols.GetLastError(), 203); // ERROR_ENVVAR_NOT_FOUND
        } finally {
          api.close();
        }
      }
      const result = await runProcess({
        executablePath: process.execPath,
        args: ["--no-env-file", "-e", ${JSON.stringify(`process.stdout.write(JSON.stringify([process.env[${JSON.stringify(key)}], process.env[${JSON.stringify(emptyKey)}]]));`)}],
        maxOutputBytes: 65536, timeoutMs: 30000,
      }, new AbortController().signal);
      assert.equal(result.exitCode, 0);
      process.stdout.write(Buffer.from(result.stdoutBase64, "base64"));
    `,
    );
    const parent = Bun.spawn(
      [
        process.execPath,
        "--env-file",
        envFile,
        runnerFile,
      ],
      {
        cwd: root,
        env: {
          ...process.env,
        },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 5000,
      },
    );
    const [exitCode, output, error] = await Promise.all([
      parent.exited,
      new Response(parent.stdout).text(),
      new Response(parent.stderr).text(),
    ]);
    expect({
      exitCode,
      error,
    }).toEqual({
      exitCode: 0,
      error: "",
    });
    expect(JSON.parse(output)).toEqual([
      value,
      "",
    ]);
  } finally {
    await rm(root, {
      recursive: true,
      force: true,
    });
  }
});

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

test.skipIf(process.platform !== "win32")(
  "invocation Jobs reap grandchildren with inherited pipes on cancellation, timeout, overflow and root completion",
  async () => {
    for (const ending of [
      "cancel",
      "timeout",
      "overflow",
      "complete",
    ] as const) {
      const root = await mkdtemp(join(tmpdir(), "bunaway-process-tree-"));
      const state = initialize();
      const controller = new AbortController();
      const pidFile = join(root, "pids");
      const releaseFile = join(root, "release");
      // Spawn immediately, before the parent's first await. Inherited output
      // pipes remain open even when the root has exited or been terminated.
      const script = `
        const leaf = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
          stdin: "ignore", stdout: "inherit", stderr: "inherit"
        });
        await Bun.write(${JSON.stringify(`${pidFile}.pending`)}, JSON.stringify([process.pid, leaf.pid]));
        await (await import("node:fs/promises")).rename(${JSON.stringify(`${pidFile}.pending`)}, ${JSON.stringify(pidFile)});
        while (!(await Bun.file(${JSON.stringify(releaseFile)}).exists())) await Bun.sleep(2);
        ${ending === "overflow" ? 'process.stdout.write("overflow");' : ""}
        ${ending === "complete" ? "process.exit(23);" : "setInterval(() => {}, 1000);"}
      `;
      const pending = run(
        state,
        {
          ...defaults,
          args: [
            "-e",
            script,
          ],
          maxOutputBytes: ending === "overflow" ? 0 : defaults.maxOutputBytes,
          timeoutMs: ending === "timeout" ? 3000 : defaults.timeoutMs,
        },
        controller.signal,
      );
      const observed = pending.catch((error: unknown) => error);
      const probes: ReturnType<typeof processExitProbe>[] = [];
      try {
        const deadline = Date.now() + 2000;
        while (!(await Bun.file(pidFile).exists())) {
          expect(Date.now()).toBeLessThan(deadline);
          await Bun.sleep(2);
        }
        const pids = JSON.parse(await readFile(pidFile, "utf8")) as number[];
        for (const pid of pids) {
          const probe = processExitProbe(pid);
          probes.push(probe);
          expect(probe.exited()).toBe(false);
        }
        if (ending === "cancel") {
          controller.abort();
        } else {
          await Bun.write(releaseFile, "release");
        }
        const result = await observed;
        const exitStates = probes.map((probe, index) => ({
          ending,
          role: index === 0 ? "root" : "leaf",
          pid: pids[index],
          exited: probe.exited(),
        }));
        expect(result).toMatchObject(
          ending === "complete"
            ? {
                pid: pids[0],
                exitCode: 23,
                signal: null,
              }
            : {
                code:
                  ending === "timeout"
                    ? "TIMEOUT"
                    : ending === "cancel"
                      ? "CANCELLED"
                      : "INTERNAL",
              },
        );
        if (ending === "overflow") {
          expect(result).toMatchObject({
            code: "INTERNAL",
            message: "Process output exceeds the limit.",
          });
        }
        // Capture identities while alive and require native death before the
        // invocation settles. A PID lookup after return could hide PID reuse.
        expect(exitStates).toEqual(
          pids.map((pid, index) => ({
            ending,
            role: index === 0 ? "root" : "leaf",
            pid,
            exited: true,
          })),
        );
        expect(state.active.size).toBe(0);
      } finally {
        controller.abort();
        await observed;
        await dispose(state);
        for (const probe of probes) {
          probe.dispose();
        }
        await rm(root, {
          recursive: true,
          force: true,
        });
      }
    }
  },
  15000,
);

test.skipIf(process.platform !== "win32")(
  "blocked maximum stdin remains cancellable and startup failures release invocation capacity",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "bunaway-process-input-"));
    const state = initialize();
    const controller = new AbortController();
    let observed: Promise<unknown> | undefined;
    let probe: ReturnType<typeof processExitProbe> | undefined;
    try {
      for (let attempt = 0; attempt < 12; attempt++) {
        await expect(
          run(state, {
            ...defaults,
            executablePath: join(root, "missing.exe"),
          }),
        ).rejects.toMatchObject({
          code: "INTERNAL",
        });
        expect(state.active.size).toBe(0);
      }
      const pidFile = join(root, "pid");
      observed = run(
        state,
        {
          ...defaults,
          args: [
            resolve(import.meta.dir, "../fixtures/process-ready.ts"),
            pidFile,
          ],
          stdinBase64: Buffer.alloc(65536, 255).toString("base64"),
        },
        controller.signal,
      ).catch((error: unknown) => error);
      const deadline = Date.now() + 2000;
      while (!(await Bun.file(pidFile).exists())) {
        expect(Date.now()).toBeLessThan(deadline);
        await Bun.sleep(2);
      }
      probe = processExitProbe(Number(await readFile(pidFile, "utf8")));
      expect(probe.exited()).toBe(false);
      controller.abort();
      expect(await observed).toMatchObject({
        code: "CANCELLED",
      });
      expect(probe.exited()).toBe(true);
      expect(state.active.size).toBe(0);
      const bytes = Buffer.alloc(65536, 255);
      const result = await run(state, {
        ...defaults,
        stdinBase64: bytes.toString("base64"),
        args: [
          "-e",
          "process.stdout.write(Buffer.from(await Bun.stdin.arrayBuffer()))",
        ],
      });
      expect(result.stdoutBase64).toBe(bytes.toString("base64"));
    } finally {
      controller.abort();
      await observed;
      await dispose(state);
      probe?.dispose();
      await rm(root, {
        recursive: true,
        force: true,
      });
    }
  },
);

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
