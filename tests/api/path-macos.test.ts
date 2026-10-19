import { expect, test } from "bun:test";
import path from "@bunaway/plugin-path/native/macos";
import { appDirectorySchema } from "../../plugins/path/src/contract.ts";
import { macosPathOperations } from "../../plugins/path/src/macos-operations.ts";
import { MacosPath } from "../../plugins/path/src/platforms/macos.ts";
import { pluginParsers } from "../fixtures/plugin-parsers.ts";

const parsers = pluginParsers("path", macosPathOperations);
const appId = "com.example.app";
const home = "/Users/한글";
const dataRoot = `${home}/Library/Application Support/bunaway/${appId}`;
const app = {
  id: appId,
  launch: {
    mode: "development" as const,
    executablePath: "/bun",
    args: [],
  },
};

test("user directories are fixed subfolders of the home that the data root layout implies", () => {
  const paths = new MacosPath({
    app,
    dataRoot,
  });
  expect(paths.getDirectory("home")).toBe(home);
  expect(paths.getDirectory("documents")).toBe(`${home}/Documents`);
  expect(paths.getDirectory("downloads")).toBe(`${home}/Downloads`);
  expect(paths.getDirectory("desktop")).toBe(`${home}/Desktop`);
  expect(paths.getDirectory("pictures")).toBe(`${home}/Pictures`);
  expect(paths.getDirectory("music")).toBe(`${home}/Music`);
  expect(paths.getDirectory("videos")).toBe(`${home}/Movies`);
});

test("a sandbox container home is used as is", () => {
  const container = "/Users/a/Library/Containers/com.example.app/Data";
  const paths = new MacosPath({
    app,
    dataRoot: `${container}/Library/Application Support/bunaway/${appId}`,
  });
  expect(paths.getDirectory("documents")).toBe(`${container}/Documents`);
});

test("app directories keep dataRoot private and put cache under Library/Caches", () => {
  const paths = new MacosPath({
    app,
    dataRoot,
  });
  expect(paths.getAppDirectory("appConfig")).toBe(`${dataRoot}/data`);
  expect(paths.getAppDirectory("appData")).toBe(`${dataRoot}/data`);
  expect(paths.getAppDirectory("appLocalData")).toBe(`${dataRoot}/data`);
  expect(paths.getAppDirectory("logs")).toBe(`${dataRoot}/logs`);
  expect(paths.getAppDirectory("cache")).toBe(
    `${home}/Library/Caches/bunaway/${appId}`,
  );
  for (const directory of appDirectorySchema.options) {
    expect(paths.getAppDirectory(directory)).not.toBe(dataRoot);
  }
});

test("the temporary directory is the process one and must be absolute", () => {
  const paths = new MacosPath({
    app,
    dataRoot,
  });
  const saved = process.env.TMPDIR;
  try {
    process.env.TMPDIR = `${dataRoot}/temp`;
    expect(paths.getAppDirectory("temp")).toBe(`${dataRoot}/temp`);
    process.env.TMPDIR = "relative/tmp";
    expect(() => paths.getAppDirectory("temp")).toThrow("absolute");
  } finally {
    if (saved === undefined) {
      delete process.env.TMPDIR;
    } else {
      process.env.TMPDIR = saved;
    }
  }
});

test("a data root outside the host layout or a missing app identifier fails with INTERNAL", () => {
  expect(() =>
    new MacosPath({
      app,
      dataRoot: "/tmp/elsewhere",
    }).getDirectory("home"),
  ).toThrow("does not match");
  expect(() =>
    new MacosPath({
      app,
      dataRoot: "/Library/Application Support/bunaway/com.example.app",
    }).getDirectory("home"),
  ).toThrow("does not match");
  expect(() =>
    new MacosPath({
      dataRoot,
    }).getAppDirectory("cache"),
  ).toThrow("app identifier");
});

test("lexical helpers follow POSIX semantics and resolve never uses the working directory", () => {
  const paths = new MacosPath({
    app,
    dataRoot,
  });
  expect(paths.join([])).toBe(".");
  expect(
    paths.join([
      "/한글",
      "folder",
      "..",
      "🙂.txt",
    ]),
  ).toBe("/한글/🙂.txt");
  expect(paths.normalize("//a/./b/../c/")).toBe("/a/c/");
  expect(paths.basename("/a/b.txt", ".txt")).toBe("b");
  expect(paths.dirname("/a/b.txt")).toBe("/a");
  expect(paths.extname("/a/b.tar.gz")).toBe(".gz");
  expect(paths.isAbsolute("/a")).toBe(true);
  expect(paths.isAbsolute("C:\\a")).toBe(false);
  expect(
    paths.resolve("/앱/data", [
      "..",
      "x",
      "/y",
      "z",
    ]),
  ).toBe("/y/z");
  expect(
    paths.resolve("/앱/data", [
      "..",
      "x",
    ]),
  ).toBe("/앱/x");
});

test("the macOS operations require absolute POSIX paths for results and the resolve base", async () => {
  for (const value of [
    "C:/Users/a",
    "relative",
    "",
    "/a\nb",
  ]) {
    await expect(
      parsers.validateOutput("path.getDirectory", value),
    ).rejects.toMatchObject({
      code: "INTERNAL",
    });
  }
  await parsers.validateOutput("path.getDirectory", "/Users/a");
  await expect(
    parsers.validateCall({
      operation: "path.resolve",
      payload: {
        base: "relative",
        paths: [],
      },
    }),
  ).rejects.toThrow();
  await expect(
    parsers.validateCall({
      operation: "path.resolve",
      payload: {
        base: "/base",
        paths: [
          "C:x",
        ],
      },
    }),
  ).resolves.toBeDefined();
});

test("the macOS adapter dispatches the path operations", async () => {
  const create = path._definition.nativePlatforms.macos?.create;
  if (!create) {
    throw new Error("macOS path adapter is missing.");
  }
  const adapter = create({
    app,
    dataRoot,
    capabilities: [],
  });
  try {
    expect(
      await adapter.execute(
        "path.getDirectory",
        {
          directory: "downloads",
        },
        "backend",
      ),
    ).toBe(`${home}/Downloads`);
    expect(
      await adapter.execute(
        "path.join",
        {
          paths: [
            "/a",
            "b",
          ],
        },
        "backend",
      ),
    ).toBe("/a/b");
  } finally {
    adapter.dispose();
  }
});
