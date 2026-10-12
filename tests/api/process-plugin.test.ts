import { expect, test } from "bun:test";
import { processes, processPlugin } from "@bunaway/plugin-process";
import { NativeRegistry } from "@bunaway/protocol";
import { processOperations } from "#plugins/process/src/contract";

test("process contract allows local .exe argv but rejects shell strings, PATH, shares, env/cwd and excessive input", () => {
  const schema = processOperations.run.input;
  expect(
    schema.parse({
      executablePath: "C:/Program Files/한글/tool.exe",
    }),
  ).toMatchObject({
    args: [],
    timeoutMs: 30000,
    maxOutputBytes: 65536,
  });
  expect(
    schema.safeParse({
      executablePath: "C:/tools/a.exe",
      args: [
        "",
        'a"b',
        "& %PATH%",
        "😀",
      ],
    }).success,
  ).toBe(true);
  // Ampersands in an executable filename are literal path characters, never a shell expression.
  expect(
    schema.safeParse({
      executablePath: "C:/tools/a & b.exe",
    }).success,
  ).toBe(true);
  for (const executablePath of [
    "bun",
    "relative.exe",
    "C:relative.exe",
    "C:/x.cmd",
    "C:/x.bat",
    "C:/x.exe\0",
    "C:/dir/../x.exe",
    "C:/x.exe:stream.exe",
    "\\\\server\\share\\x.exe",
    "\\\\?\\C:\\x.exe",
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
      cwd: "C:/other",
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
        executablePath: "C:/tools/a.exe",
        ...extra,
      }).success,
    ).toBe(false);
  }
  expect(Object.keys(processes)).toEqual([
    "run",
  ]);
  const registry = new NativeRegistry([
    processPlugin,
  ]);
  const call = {
    operation: "process.run",
    payload: null,
  };
  expect(
    registry.allowed(
      {
        permissions: [
          "process.run",
        ],
      },
      call,
    ),
  ).toBe(true);
  expect(
    registry.allowed(
      {
        permissions: [],
      },
      call,
    ),
  ).toBe(false);
  expect(
    registry.allowed(
      {
        permissions: [
          "opener.openFile",
        ],
      },
      call,
    ),
  ).toBe(false);
});
