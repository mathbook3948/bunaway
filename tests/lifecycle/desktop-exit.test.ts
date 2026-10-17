import { expect, test } from "bun:test";
import type { DesktopOptions } from "@bunaway/core";
import { DesktopLifecycle } from "#native/windows/bun/desktop";
import { quoteWindowsArgument } from "#native/windows/bun/job";
import {
  RELAUNCH_ENVIRONMENT,
  relaunchCommand,
} from "#native/windows/bun/relaunch";

function lifecycle(options: DesktopOptions = {}, relaunchSupported = true) {
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
  expect(
    await desktop.context.quit({
      exitCode: 9,
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
  ).toBe(true);
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
  // Later quit requests are moot and never consult beforeQuit.
  expect(
    await desktop.context.quit({
      exitCode: 1,
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
  // The veto arrives after the forced exit and cannot cancel it.
  expect(await quitting).toBe(true);
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
  // A later plain quit or relaunch cannot change the committed request.
  expect(
    await desktop.context.relaunch({
      argv: [
        "other",
      ],
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
  ).toBe(true);
  expect(ended.desktop.relaunch).toBeUndefined();
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
