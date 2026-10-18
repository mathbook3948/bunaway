import { expect, test } from "bun:test";
import path from "@bunaway/plugin-path/native/windows";
import { NativeRegistry } from "@bunaway/protocol";
import {
  appDirectorySchema,
  qualifiedPathSchema,
} from "../../plugins/path/src/contract.ts";
import { pathOperations } from "../../plugins/path/src/operations.ts";
import { WindowsPath } from "../../plugins/path/src/platforms/windows.ts";
import { pluginParsers } from "../fixtures/plugin-parsers.ts";

const parsers = pluginParsers("path", pathOperations);

test("app directory names are a closed set that excludes resources and host-internal roots", () => {
  expect(appDirectorySchema.options).toEqual([
    "appConfig",
    "appData",
    "appLocalData",
    "cache",
    "logs",
    "temp",
  ]);
});

test("getAppDirectory validates input strictly and requires its own permission", async () => {
  for (const payload of [
    {
      directory: "resources",
    },
    {
      directory: "dataRoot",
    },
    {
      directory: "logs",
      create: true,
    },
    {},
  ]) {
    await expect(
      parsers.validateCall({
        operation: "path.getAppDirectory",
        payload,
      }),
    ).rejects.toThrow();
  }
  const registry = new NativeRegistry([
    path._definition,
  ]);
  const request = {
    operation: "path.getAppDirectory",
    payload: {
      directory: "logs",
    },
  };
  expect(
    registry.allowed(
      {
        permissions: [
          "path.getDirectory",
        ],
      },
      request,
    ),
  ).toBe(false);
  expect(
    registry.allowed(
      {
        permissions: [
          "path.getAppDirectory",
        ],
      },
      request,
    ),
  ).toBe(true);
});

test("local app directories sit under the host data root and logs match the log plugin location", () => {
  const dataRoot = "C:\\Users\\a\\AppData\\Local\\bunaway\\com.example.app";
  const paths = new WindowsPath({
    app: {
      id: "com.example.app",
      launch: {
        mode: "development",
        executablePath: "C:\\bun.exe",
        args: [],
      },
    },
    dataRoot,
  });
  expect(paths.getAppDirectory("logs")).toBe(`${dataRoot}\\logs`);
  expect(paths.getAppDirectory("cache")).toBe(`${dataRoot}\\cache`);
  expect(paths.getAppDirectory("appLocalData")).toBe(`${dataRoot}\\data`);
  for (const directory of appDirectorySchema.options) {
    // Roaming paths come from the OS and temp from the process environment, so neither is data-root based.
    if (
      directory === "appConfig" ||
      directory === "appData" ||
      directory === "temp"
    ) {
      continue;
    }
    // The host-owned root, which holds WebView profiles and the instance lock, is never returned.
    expect(paths.getAppDirectory(directory)).not.toBe(dataRoot);
  }
  for (const directory of [
    "appLocalData",
    "cache",
    "logs",
  ] as const) {
    expect(
      qualifiedPathSchema.safeParse(paths.getAppDirectory(directory)).success,
    ).toBe(true);
  }
  paths.dispose();
});

test("app directories fail with INTERNAL when the host provides no app identifier", () => {
  const paths = new WindowsPath({
    dataRoot: "C:\\data",
  });
  expect(() => paths.getAppDirectory("logs")).toThrow(
    "The host did not provide an app identifier.",
  );
  // temp is the system temporary directory and needs no app identity, only a qualified value.
  const temp = process.platform === "win32" ? "C:\\Temp" : "/tmp";
  const restore = setTempEnvironment(temp);
  try {
    expect(() => paths.getAppDirectory("temp")).not.toThrow(
      "The host did not provide an app identifier.",
    );
  } finally {
    restore();
  }
});

/** Point every variable os.tmpdir reads at one value and return a restore function. */
function setTempEnvironment(value: string): () => void {
  const names = [
    "TEMP",
    "TMP",
    "TMPDIR",
  ];
  const saved = names.map((name) => process.env[name]);
  for (const name of names) {
    process.env[name] = value;
  }
  return () => {
    names.forEach((name, index) => {
      const previous = saved[index];
      if (previous === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = previous;
      }
    });
  };
}

test("temp fails with INTERNAL when the temporary directory is empty or relative", () => {
  const paths = new WindowsPath({
    dataRoot: "C:\\data",
  });
  for (const value of [
    "relative\\temp",
    "",
  ]) {
    const restore = setTempEnvironment(value);
    try {
      expect(() => paths.getAppDirectory("temp")).toThrow(
        expect.objectContaining({
          code: "INTERNAL",
        }),
      );
    } finally {
      restore();
    }
  }
});
