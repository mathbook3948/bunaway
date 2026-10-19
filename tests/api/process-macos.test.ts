import { expect, test } from "bun:test";
import processes from "@bunaway/plugin-process";
import nativeProcesses from "@bunaway/plugin-process/native/macos";
import { BunawayError } from "@bunaway/protocol";
import { macosProcessOperations } from "#plugins/process/src/operations";
import { dispose, initialize, run } from "#plugins/process/src/platforms/macos";

const schema = macosProcessOperations.run.input;
const SHELL = "/bin/sh";
/** Tests that spawn real POSIX executables; the Windows CI job runs the contract tests only. */
const posixTest = test.skipIf(process.platform === "win32");

async function runShell(script: string, extra = {}) {
  return run(
    initialize(),
    schema.parse({
      executablePath: SHELL,
      args: [
        "-c",
        script,
      ],
      ...extra,
    }),
  );
}

test("macOS contract accepts absolute POSIX paths and rejects PATH lookup, relative paths and shell-shaped input", () => {
  expect(
    schema.parse({
      executablePath: "/Applications/한글 앱.app/Contents/MacOS/tool",
    }),
  ).toMatchObject({
    args: [],
    timeoutMs: 30000,
    maxOutputBytes: 65536,
  });
  // Metacharacters are literal path and argv bytes, never shell syntax.
  expect(
    schema.safeParse({
      executablePath: "/tmp/a & b;$(x)",
      args: [
        "",
        "a'b",
        "& $PATH",
        "😀",
      ],
    }).success,
  ).toBe(true);
  for (const executablePath of [
    "sh",
    "./tool",
    "../tool",
    "tool/a",
    "~/tool",
    "/",
    "/tmp/",
    "/tmp//tool",
    "/tmp/./tool",
    "/tmp/../tool",
    "/tmp/tool\0",
    "/tmp/to\nol",
    "/tmp/to\x7fol",
    "/tmp/to\u0085ol",
    "/tmp/to\uD800ol",
    "C:/tool.exe",
    "/".repeat(1) + "a".repeat(1024),
  ]) {
    expect(
      schema.safeParse({
        executablePath,
      }).success,
    ).toBe(false);
  }
  for (const extra of [
    {
      command: "echo hi",
    },
    {
      cwd: "/tmp",
    },
    {
      env: {
        PATH: "other",
      },
    },
    {
      args: [
        "\0",
      ],
    },
    {
      args: Array(128).fill("a".repeat(4096)),
    },
    {
      timeoutMs: 30001,
    },
    {
      stdinBase64: Buffer.alloc(65537).toString("base64"),
    },
  ]) {
    expect(
      schema.safeParse({
        executablePath: SHELL,
        ...extra,
      }).success,
    ).toBe(false);
  }
});

test("macOS argv bound counts UTF-8 bytes, not UTF-16 units", () => {
  const args = Array(100).fill("한".repeat(4096));
  expect(
    schema.safeParse({
      executablePath: SHELL,
      args,
    }).success,
  ).toBe(false);
  expect(
    schema.safeParse({
      executablePath: SHELL,
      args: args.slice(0, 20),
    }).success,
  ).toBe(true);
});

test("the plugin registers the same run operation for macOS", () => {
  expect(Object.keys(processes)).toEqual([
    "run",
  ]);
  expect(Object.keys(macosProcessOperations)).toEqual([
    "run",
  ]);
  expect(macosProcessOperations.run.output).toBeDefined();
});

posixTest(
  "run returns exact argv, stdin and binary output without a shell",
  async () => {
    const result = await run(
      initialize(),
      schema.parse({
        executablePath: SHELL,
        args: [
          "-c",
          'printf "%s|%s" "$0" "$1"; cat >&2',
          "a & b",
          "$HOME",
        ],
        stdinBase64: Buffer.from([
          0,
          255,
          10,
        ]).toString("base64"),
      }),
    );
    expect(result.exitCode).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.pid).toBeGreaterThan(0);
    expect(Buffer.from(result.stdoutBase64, "base64").toString()).toBe(
      "a & b|$HOME",
    );
    expect([
      ...Buffer.from(result.stderrBase64, "base64"),
    ]).toEqual([
      0,
      255,
      10,
    ]);
  },
);

posixTest("run reports the exit code and the terminating signal", async () => {
  expect((await runShell("exit 3")).exitCode).toBe(3);
  const killed = await runShell("kill -TERM $$");
  expect(killed.signal).toBe("SIGTERM");
  expect(killed.exitCode).toBe(143);
});

posixTest(
  "output above maxOutputBytes fails and a missing executable is an internal error",
  async () => {
    await expect(
      runShell('printf "abcdef"', {
        maxOutputBytes: 3,
      }),
    ).rejects.toMatchObject({
      code: "INTERNAL",
    });
    await expect(
      run(
        initialize(),
        schema.parse({
          executablePath: "/nonexistent/bunaway-tool",
        }),
      ),
    ).rejects.toMatchObject({
      code: "INTERNAL",
    });
  },
);

posixTest(
  "timeout and request cancellation kill the direct child and wait for it",
  async () => {
    const state = initialize();
    const started = Date.now();
    await expect(
      run(
        state,
        schema.parse({
          executablePath: SHELL,
          args: [
            "-c",
            "exec sleep 30",
          ],
          timeoutMs: 100,
        }),
      ),
    ).rejects.toMatchObject({
      code: "TIMEOUT",
    });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(state.active.size).toBe(0);
    const controller = new AbortController();
    const pending = run(
      state,
      schema.parse({
        executablePath: SHELL,
        args: [
          "-c",
          "exec sleep 30",
        ],
      }),
      controller.signal,
    );
    setTimeout(() => controller.abort(), 50);
    await expect(pending).rejects.toMatchObject({
      code: "CANCELLED",
    });
    expect(state.active.size).toBe(0);
  },
);

posixTest(
  "the adapter limits concurrency and dispose drains active children",
  async () => {
    const state = initialize();
    const input = schema.parse({
      executablePath: SHELL,
      args: [
        "-c",
        "exec sleep 30",
      ],
    });
    const pending = Array.from(
      {
        length: 8,
      },
      () => run(state, input),
    );
    const settled = pending.map((promise) =>
      promise.then(
        () => null,
        (error: unknown) => error,
      ),
    );
    await expect(run(state, input)).rejects.toMatchObject({
      code: "BUSY",
    });
    await dispose(state);
    for (const error of await Promise.all(settled)) {
      expect(error).toBeInstanceOf(BunawayError);
      expect(error).toMatchObject({
        code: "CANCELLED",
      });
    }
    expect(state.active.size).toBe(0);
    await expect(run(state, input)).rejects.toMatchObject({
      code: "CANCELLED",
    });
  },
);

posixTest(
  "a descendant holding the pipes open delays completion until the timeout",
  async () => {
    const started = Date.now();
    await expect(
      runShell("sleep 5 & exit 0", {
        timeoutMs: 300,
      }),
    ).rejects.toMatchObject({
      code: "TIMEOUT",
    });
    // The call returns at the deadline once the pipes are closed, not when the descendant exits.
    expect(Date.now() - started).toBeLessThan(3_000);
  },
);

posixTest(
  "the child receives only PATH, never the host environment",
  async () => {
    const key = `BUNAWAY_PROCESS_HOST_SECRET_${crypto.randomUUID().replaceAll("-", "_")}`;
    process.env[key] = "secret";
    try {
      const result = await run(
        initialize(),
        schema.parse({
          executablePath: "/usr/bin/env",
        }),
      );
      // macOS may add system variables such as __CF_USER_TEXT_ENCODING, so assert on what must differ.
      const lines = Buffer.from(result.stdoutBase64, "base64")
        .toString()
        .split("\n");
      expect(lines).toContain("PATH=/usr/bin:/bin");
      expect(lines.filter((line) => line.includes(key))).toEqual([]);
      expect(lines.filter((line) => line.startsWith("HOME="))).toEqual([]);
    } finally {
      delete process.env[key];
    }
  },
);

posixTest(
  "a child that keeps writing is killed when the output limit is exceeded",
  async () => {
    const started = Date.now();
    await expect(
      run(
        initialize(),
        schema.parse({
          executablePath: "/usr/bin/yes",
          maxOutputBytes: 3,
        }),
      ),
    ).rejects.toMatchObject({
      code: "INTERNAL",
    });
    expect(Date.now() - started).toBeLessThan(10_000);
  },
);

test("the registered macOS adapter validates with the macOS schema and rejects Windows paths", async () => {
  const definition = nativeProcesses._definition.nativePlatforms.macos;
  expect(definition?.operations).toEqual([
    "run",
  ]);
  const adapter = definition?.create({
    dataRoot: ".",
    capabilities: [],
  });
  try {
    await expect(
      adapter?.execute(
        "process.run",
        {
          executablePath: "C:/tools/a.exe",
        },
        "backend",
      ),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    await expect(
      adapter?.execute(
        "process.run",
        {
          executablePath: SHELL,
          args: [
            "a\uD800",
          ],
        },
        "backend",
      ),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  } finally {
    await adapter?.dispose();
  }
});

posixTest(
  "the registered macOS adapter runs a process and its disposal drains a running child",
  async () => {
    const adapter = nativeProcesses._definition.nativePlatforms.macos?.create({
      dataRoot: ".",
      capabilities: [],
    });
    const result = await adapter?.execute(
      "process.run",
      {
        executablePath: SHELL,
        args: [
          "-c",
          "printf ok",
        ],
      },
      "backend",
    );
    expect(result).toMatchObject({
      exitCode: 0,
      signal: null,
      stdoutBase64: Buffer.from("ok").toString("base64"),
    });
    const pending = adapter?.execute(
      "process.run",
      {
        executablePath: SHELL,
        args: [
          "-c",
          "exec sleep 30",
        ],
      },
      "backend",
    );
    const settled = pending?.then(
      () => null,
      (error: unknown) => error,
    );
    await adapter?.dispose();
    expect(await settled).toMatchObject({
      code: "CANCELLED",
    });
  },
);
