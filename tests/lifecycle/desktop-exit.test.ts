import { expect, test } from "bun:test";
import type { DesktopOptions } from "@bunaway/core";
import { DesktopLifecycle } from "#native/windows/bun/desktop";
import {
  quoteWindowsArgument,
  relaunchCommandLine,
  relaunchCommandLineTooLong,
} from "#native/windows/bun/job";
import {
  RELAUNCH_ENVIRONMENT,
  relaunchCommand,
} from "#native/windows/bun/relaunch";

function lifecycle(
  options: DesktopOptions = {},
  relaunchSupported = true,
  checkRelaunch?: (argv: readonly string[] | undefined) => void,
) {
  const stops: string[] = [];
  const reports: unknown[] = [];
  const desktop = new DesktopLifecycle(
    options,
    async () => {},
    () => {
      stops.push("stop");
    },
    (error) => {
      reports.push(error);
    },
    undefined,
    relaunchSupported,
    checkRelaunch,
  );
  return {
    desktop,
    stops,
    reports,
  };
}

const invalidCodes = [
  -1,
  256,
  1.5,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  "3",
  null,
];

test("quit and exit reject exit codes outside the 0 to 255 integer range without shutting down", async () => {
  const { desktop, stops } = lifecycle();
  for (const exitCode of invalidCodes) {
    await expect(
      desktop.context.quit({
        exitCode: exitCode as number,
      }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    await expect(
      desktop.context.exit(exitCode as number),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    await expect(
      desktop.context.relaunch({
        exitCode: exitCode as number,
      }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  }
  await expect(
    desktop.context.quit(
      [] as unknown as {
        exitCode: number;
      },
    ),
  ).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  });
  expect(stops).toEqual([]);
  expect(desktop.exitCode).toBe(0);
  // Both ends of the range are valid.
  expect(
    await desktop.context.quit({
      exitCode: 255,
    }),
  ).toBe(true);
  expect(desktop.exitCode).toBe(255);
});

test("an approved quit keeps its exit code and the first committed code wins", async () => {
  const { desktop, stops } = lifecycle();
  expect(
    await desktop.context.quit({
      exitCode: 7,
    }),
  ).toBe(true);
  // The committed shutdown keeps its code: a different request is not applied.
  expect(
    await desktop.context.quit({
      exitCode: 9,
    }),
  ).toBe(false);
  expect(
    await desktop.context.quit({
      exitCode: 7,
    }),
  ).toBe(true);
  desktop.commitShutdown("interrupted", {
    exitCode: 11,
  });
  expect(desktop.exitCode).toBe(7);
  expect(stops).toEqual([
    "stop",
  ]);

  // A shutdown another cause committed first keeps the default code.
  const other = lifecycle();
  other.desktop.commitShutdown("interrupted");
  expect(
    await other.desktop.context.quit({
      exitCode: 5,
    }),
  ).toBe(false);
  expect(await other.desktop.context.quit()).toBe(true);
  expect(other.desktop.exitCode).toBe(0);
});

test("a beforeQuit veto discards the requested exit code and relaunch", async () => {
  let veto = true;
  const { desktop, stops } = lifecycle({
    beforeQuit: () => !veto,
  });
  expect(
    await desktop.context.quit({
      exitCode: 3,
    }),
  ).toBe(false);
  expect(
    await desktop.context.relaunch({
      exitCode: 4,
      argv: [
        "--again",
      ],
    }),
  ).toBe(false);
  expect(desktop.exitCode).toBe(0);
  expect(desktop.relaunch).toBeUndefined();
  veto = false;
  expect(await desktop.context.quit()).toBe(true);
  expect(desktop.exitCode).toBe(0);
  expect(stops).toEqual([
    "stop",
  ]);
});

test("exit skips beforeQuit, onWillQuit and onQuit but commits once with its code", async () => {
  const seen: string[] = [];
  const { desktop, stops } = lifecycle({
    beforeQuit: () => {
      seen.push("beforeQuit");
      return false;
    },
    onWillQuit: () => {
      seen.push("onWillQuit");
    },
    onQuit: () => {
      seen.push("onQuit");
    },
  });
  await desktop.context.exit(9);
  await desktop.context.exit(2);
  await desktop.willQuit();
  await desktop.quitCompleted();
  expect(seen).toEqual([]);
  expect(desktop.exitCode).toBe(9);
  expect(stops).toEqual([
    "stop",
  ]);
  // Later quit requests never consult beforeQuit; only one matching the exit joins it.
  expect(
    await desktop.context.quit({
      exitCode: 1,
    }),
  ).toBe(false);
  expect(
    await desktop.context.quit({
      exitCode: 9,
    }),
  ).toBe(true);
  expect(desktop.exitCode).toBe(9);
  expect(seen).toEqual([]);
});

test("exit replaces the code and relaunch of a quit that is already committed", async () => {
  const seen: string[] = [];
  const { desktop, stops } = lifecycle({
    onWillQuit: () => {
      seen.push("onWillQuit");
    },
  });
  expect(
    await desktop.context.relaunch({
      exitCode: 4,
      argv: [
        "--again",
      ],
    }),
  ).toBe(true);
  expect(desktop.relaunch).toEqual({
    argv: [
      "--again",
    ],
  });
  await desktop.context.exit(6);
  await desktop.willQuit();
  expect(desktop.exitCode).toBe(6);
  expect(desktop.relaunch).toBeUndefined();
  expect(seen).toEqual([]);
  // The host was already told to stop; exit does not announce it again.
  expect(stops).toEqual([
    "stop",
  ]);
});

test("exit makes a pending beforeQuit decision moot", async () => {
  const decision = Promise.withResolvers<boolean>();
  const seen: string[] = [];
  const { desktop, stops } = lifecycle({
    beforeQuit: () => decision.promise,
    onQuit: () => {
      seen.push("onQuit");
    },
  });
  const quitting = desktop.context.quit({
    exitCode: 3,
  });
  await desktop.context.exit(8);
  decision.resolve(false);
  // The veto arrives after the forced exit and cannot cancel it. The quit's own exit code 3 was
  // replaced by the exit, so that request was not applied.
  expect(await quitting).toBe(false);
  expect(desktop.exitCode).toBe(8);
  expect(stops).toEqual([
    "stop",
  ]);
  await desktop.quitCompleted();
  expect(seen).toEqual([]);
});

test("relaunch records validated arguments and the first committed request wins", async () => {
  const { desktop } = lifecycle();
  await expect(
    desktop.context.relaunch({
      argv: [
        "a\0b",
      ],
    }),
  ).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  });
  await expect(
    desktop.context.relaunch({
      argv: [
        1,
      ] as unknown as string[],
    }),
  ).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  });
  await expect(
    desktop.context.relaunch({
      argv: Array(257).fill("x"),
    }),
  ).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  });
  expect(
    await desktop.context.relaunch({
      argv: [
        "--again",
        "x y",
      ],
      exitCode: 4,
    }),
  ).toBe(true);
  expect(desktop.relaunch).toEqual({
    argv: [
      "--again",
      "x y",
    ],
  });
  expect(desktop.exitCode).toBe(4);
  // A later request cannot change the committed one; only an identical one joins it.
  expect(
    await desktop.context.relaunch({
      argv: [
        "other",
      ],
      exitCode: 4,
    }),
  ).toBe(false);
  expect(await desktop.context.quit()).toBe(false);
  expect(
    await desktop.context.relaunch({
      argv: [
        "--again",
        "x y",
      ],
      exitCode: 4,
    }),
  ).toBe(true);
  expect(desktop.relaunch).toEqual({
    argv: [
      "--again",
      "x y",
    ],
  });

  const defaults = lifecycle();
  expect(await defaults.desktop.context.relaunch()).toBe(true);
  expect(defaults.desktop.relaunch).toEqual({
    argv: undefined,
  });

  // A session end committed first cannot be turned into a relaunch.
  const ended = lifecycle();
  ended.desktop.commitShutdown("session-end");
  expect(
    await ended.desktop.context.relaunch({
      argv: [
        "x",
      ],
    }),
  ).toBe(false);
  expect(ended.desktop.relaunch).toBeUndefined();
});

test("a request overlapping a pending beforeQuit check joins only an identical one", async () => {
  const decision = Promise.withResolvers<boolean>();
  let checks = 0;
  const { desktop, stops } = lifecycle({
    beforeQuit: () => {
      checks++;
      return decision.promise;
    },
  });
  const first = desktop.context.relaunch({
    argv: [
      "--again",
    ],
    exitCode: 2,
  });
  // Identical request: the same pending decision.
  const same = desktop.context.relaunch({
    argv: [
      "--again",
    ],
    exitCode: 2,
  });
  // Different exit code, different argv, no relaunch, or default argv: not applied.
  for (const other of [
    desktop.context.relaunch({
      argv: [
        "--again",
      ],
      exitCode: 3,
    }),
    desktop.context.relaunch({
      argv: [
        "--other",
      ],
      exitCode: 2,
    }),
    desktop.context.relaunch({
      exitCode: 2,
    }),
    desktop.context.quit({
      exitCode: 2,
    }),
  ]) {
    expect(await other).toBe(false);
  }
  // A host-initiated quit (tray, last window) joins whatever is pending.
  const tray = desktop.quit("tray");
  expect(checks).toBe(1);
  expect(stops).toEqual([]);
  decision.resolve(true);
  expect(await first).toBe(true);
  expect(await same).toBe(true);
  expect(await tray).toBe(true);
  expect(desktop.exitCode).toBe(2);
  expect(desktop.relaunch).toEqual({
    argv: [
      "--again",
    ],
  });
  expect(stops).toEqual([
    "stop",
  ]);
});

test("a rejected overlapping request does not cancel the pending shutdown", async () => {
  const decision = Promise.withResolvers<boolean>();
  const { desktop } = lifecycle({
    beforeQuit: () => decision.promise,
  });
  const first = desktop.context.quit();
  expect(
    await desktop.context.quit({
      exitCode: 9,
    }),
  ).toBe(false);
  decision.resolve(true);
  expect(await first).toBe(true);
  expect(desktop.exitCode).toBe(0);
  expect(desktop.relaunch).toBeUndefined();
});

test("relaunch rejects with UNSUPPORTED on a host that cannot restart itself", async () => {
  const { desktop, stops } = lifecycle({}, false);
  await expect(desktop.context.relaunch()).rejects.toMatchObject({
    code: "UNSUPPORTED",
  });
  expect(stops).toEqual([]);
  // Quit and exit still work there.
  expect(
    await desktop.context.quit({
      exitCode: 2,
    }),
  ).toBe(true);
  expect(desktop.exitCode).toBe(2);
});

test("the relaunch command keeps the host executable, working directory and environment", () => {
  const env = {
    PATH: "C:\\Windows",
    KEEP: "1",
  };
  expect(
    relaunchCommand(
      {
        compiled: true,
        execPath: "C:\\App\\app.exe",
        execArgv: [],
        script: undefined,
        switches: [],
        cwd: "C:\\Work",
        env,
      },
      [
        "--again",
        "x y",
      ],
    ),
  ).toEqual({
    executable: "C:\\App\\app.exe",
    args: [
      "--again",
      "x y",
    ],
    cwd: "C:\\Work",
    env: {
      ...env,
      [RELAUNCH_ENVIRONMENT]: "1",
    },
  });
  // A development host repeats its Bun options, script and development switches first.
  expect(
    relaunchCommand(
      {
        compiled: false,
        execPath: "C:\\bun.exe",
        execArgv: [
          "--inspect=127.0.0.1:6499/bunaway",
        ],
        script: "C:\\pkg\\boot.ts",
        switches: [
          "--devtools",
          "--dev-url",
          "http://localhost:5173/",
        ],
        cwd: "C:\\Work",
        env,
      },
      [
        "a",
      ],
    ).args,
  ).toEqual([
    "--inspect=127.0.0.1:6499/bunaway",
    "C:\\pkg\\boot.ts",
    "--devtools",
    "--dev-url",
    "http://localhost:5173/",
    "a",
  ]);
  expect(() =>
    relaunchCommand(
      {
        compiled: false,
        execPath: "C:\\bun.exe",
        execArgv: [],
        script: undefined,
        switches: [],
        cwd: "C:\\Work",
        env,
      },
      [],
    ),
  ).toThrow("host script");
});

test("Windows argument quoting round-trips through the CommandLineToArgvW rules", () => {
  expect(quoteWindowsArgument("plain")).toBe("plain");
  expect(quoteWindowsArgument("")).toBe('""');
  expect(quoteWindowsArgument("with space")).toBe('"with space"');
  expect(quoteWindowsArgument('say "hi"')).toBe('"say \\"hi\\""');
  // Backslashes double only before a quote, including the closing one.
  expect(quoteWindowsArgument("C:\\dir\\file")).toBe("C:\\dir\\file");
  expect(quoteWindowsArgument("C:\\my dir\\")).toBe('"C:\\my dir\\\\"');
  expect(quoteWindowsArgument('a\\"b')).toBe('"a\\\\\\"b"');
});

test("a session end after a relaunch was committed cancels the relaunch", async () => {
  const { desktop } = lifecycle();
  expect(
    await desktop.context.relaunch({
      argv: [
        "--again",
      ],
      exitCode: 4,
    }),
  ).toBe(true);
  expect(desktop.relaunch).toEqual({
    argv: [
      "--again",
    ],
  });
  // Logoff arrives while the relaunching shutdown is still cleaning up.
  desktop.commitShutdown("session-end");
  expect(desktop.relaunch).toBeUndefined();
  // The committed exit code is unchanged: only the relaunch is dropped.
  expect(desktop.exitCode).toBe(4);
});

test("relaunch refuses a sparse argv array", async () => {
  const { desktop, stops } = lifecycle();
  // biome-ignore lint/suspicious/noSparseArray: the hole is the case under test.
  const sparse = [
    ,
    "a",
  ] as unknown as string[];
  await expect(
    desktop.context.relaunch({
      argv: sparse,
    }),
  ).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  });
  expect(stops).toEqual([]);
});

test("relaunch asks the host to check the real command before anything is committed", async () => {
  const checked: (readonly string[] | undefined)[] = [];
  const { desktop, stops } = lifecycle({}, true, (argv) => {
    checked.push(argv);
    if (argv?.includes("long")) {
      throw Object.assign(new Error("too long"), {
        code: "INVALID_ARGUMENT",
      });
    }
  });
  await expect(
    desktop.context.relaunch({
      argv: [
        "long",
      ],
    }),
  ).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  });
  expect(stops).toEqual([]);
  expect(desktop.relaunch).toBeUndefined();
  // Default arguments are checked too, as undefined.
  expect(await desktop.context.relaunch()).toBe(true);
  expect(checked).toEqual([
    [
      "long",
    ],
    undefined,
  ]);
});

test("the relaunch command line limit counts the quoted executable, options and arguments", () => {
  const host = {
    compiled: false,
    execPath: "C:\\Program Files\\bun.exe",
    execArgv: [
      "--inspect=127.0.0.1:6499/bunaway",
    ],
    script: "C:\\pkg\\boot.ts",
    switches: [
      "--devtools",
    ],
    cwd: "C:\\Work",
    env: {},
  };
  const line = relaunchCommandLine(
    relaunchCommand(host, [
      "a b",
    ]),
  );
  expect(line).toBe(
    '"C:\\Program Files\\bun.exe" --inspect=127.0.0.1:6499/bunaway C:\\pkg\\boot.ts --devtools "a b"',
  );
  expect(relaunchCommandLineTooLong(line)).toBe(false);
  // Arguments within the 64 KiB public limit can still exceed the process command line limit.
  const long = relaunchCommandLine(
    relaunchCommand(host, [
      "x".repeat(12_000),
      "y".repeat(12_000),
      "z".repeat(12_000),
    ]),
  );
  expect(relaunchCommandLineTooLong(long)).toBe(true);
  // Quotes grow with escaping: 20,000 quote characters double to 40,000.
  expect(
    relaunchCommandLineTooLong(
      relaunchCommandLine(
        relaunchCommand(host, [
          '"'.repeat(20_000),
        ]),
      ),
    ),
  ).toBe(true);
});
