import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  copyBuildResources,
  type PlannedResource,
  parseBuildResources,
  planBuildResources,
} from "#cli/build-resources";
import { readProjectSettings } from "#cli/config";
import { writeJson } from "#cli/files";

async function withProject(
  body: (root: string, packageRoot: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(resolve(tmpdir(), "bunaway-build-resources-"));
  try {
    const packageRoot = resolve(root, "stage");
    await mkdir(packageRoot);
    await body(root, packageRoot);
  } finally {
    await rm(root, {
      recursive: true,
      force: true,
    });
  }
}

test("build.resources accepts relative files and directories and normalizes separators", () => {
  expect(parseBuildResources(undefined)).toBeUndefined();
  expect(
    parseBuildResources([
      "resources/tray.ico",
      "data\\fonts",
    ]),
  ).toEqual([
    "resources/tray.ico",
    "data/fonts",
  ]);
});

test("build.resources rejects paths that escape, shadow build files or overlap", () => {
  for (const [value, message] of [
    [
      "a.ico",
      "must be an array",
    ],
    [
      [
        1,
      ],
      "must be an array",
    ],
    [
      [
        "../a",
      ],
      "must be a relative path",
    ],
    [
      [
        "/a",
      ],
      "must be a relative path",
    ],
    [
      [
        "C:\\a",
      ],
      "must be a relative path",
    ],
    [
      [
        "a//b",
      ],
      "must be a relative path",
    ],
    [
      [
        "./a",
      ],
      "must be a relative path",
    ],
    [
      [
        "a/NUL",
      ],
      "must be a relative path",
    ],
    [
      [
        "Assets/x",
      ],
      "build uses for its own files",
    ],
    [
      [
        "manifest.json",
      ],
      "build uses for its own files",
    ],
    [
      [
        "WebView2Loader.dll",
      ],
      "build uses for its own files",
    ],
    [
      [
        "a",
        "A",
      ],
      "duplicates or lies inside",
    ],
    [
      [
        "a/b",
        "a",
      ],
      "duplicates or lies inside",
    ],
  ] as const) {
    expect(() => parseBuildResources(value)).toThrow(message);
  }
  expect(() =>
    parseBuildResources(
      Array.from(
        {
          length: 257,
        },
        (_, i) => `r${i}`,
      ),
    ),
  ).toThrow("at most 256");
});

test("settings carry build.resources and reject a malformed list", async () => {
  await withProject(async (root) => {
    await mkdir(resolve(root, "src-bunaway"));
    const write = (resources: unknown) =>
      writeJson(resolve(root, "src-bunaway/bunaway.json"), {
        version: 1,
        build: {
          app: "src-bunaway/app.ts",
          frontend: "web",
          resources,
        },
        app: {},
      });
    await write([
      "res/tray.ico",
    ]);
    expect((await readProjectSettings(root)).resources).toEqual([
      "res/tray.ico",
    ]);
    await write([
      "../x",
    ]);
    await expect(readProjectSettings(root)).rejects.toThrow(
      "bunaway.json: build.resources",
    );
  });
});

test("build resources are copied to the same relative path in the package directory", async () => {
  await withProject(async (root, packageRoot) => {
    await mkdir(resolve(root, "res/icons/nested"), {
      recursive: true,
    });
    await writeFile(resolve(root, "res/tray.ico"), "ico");
    await writeFile(resolve(root, "res/icons/a.png"), "a");
    await writeFile(resolve(root, "res/icons/nested/b.png"), "b");
    await copyBuildResources(
      await planBuildResources(
        root,
        packageRoot,
        [
          "res/tray.ico",
          "res/icons",
        ],
        "app.exe",
      ),
    );
    expect(await readFile(resolve(packageRoot, "res/tray.ico"), "utf8")).toBe(
      "ico",
    );
    expect(
      await readFile(resolve(packageRoot, "res/icons/nested/b.png"), "utf8"),
    ).toBe("b");
    expect((await readdir(resolve(packageRoot, "res/icons"))).sort()).toEqual([
      "a.png",
      "nested",
    ]);
  });
});

test("build resources reject missing sources, links at any level, special names and build output", async () => {
  await withProject(async (root, packageRoot) => {
    await mkdir(resolve(root, "res"));
    await writeFile(resolve(root, "res/a.txt"), "a");
    await mkdir(resolve(root, "dist/windows-x64"), {
      recursive: true,
    });
    await mkdir(resolve(root, ".bunaway/work"), {
      recursive: true,
    });
    await mkdir(resolve(root, "outside"));
    await writeFile(resolve(root, "outside/x.txt"), "x");
    // Junctions need no privilege on Windows and behave as directory links elsewhere.
    await symlink(
      resolve(root, ".bunaway"),
      resolve(root, "cache"),
      "junction",
    );
    await symlink(
      resolve(root, "outside"),
      resolve(root, "res/inner"),
      "junction",
    );
    await symlink(resolve(root, "dist"), resolve(root, "alias"), "junction");
    const plan = (...entries: string[]) =>
      planBuildResources(root, packageRoot, entries, "App.exe");
    await expect(plan("missing")).rejects.toThrow("existing regular file");
    await expect(plan("res/a.txt/x")).rejects.toThrow("build.resources entry");
    await expect(plan("app.EXE")).rejects.toThrow("replace the app executable");
    await expect(plan("dist/windows-x64")).rejects.toThrow("app outputs");
    await expect(plan(".bunaway/x")).rejects.toThrow("app outputs");
    // A link in the middle of the path would read build output the lexical check cannot see.
    await expect(plan("cache/work")).rejects.toThrow("without links");
    await expect(plan("alias/windows-x64")).rejects.toThrow("without links");
    await expect(plan("res/inner/x.txt")).rejects.toThrow("without links");
    // A link inside a declared directory is rejected by the directory walk.
    await expect(plan("res")).rejects.toThrow("Symlink not allowed");
    const planned: PlannedResource[] = await plan("res/a.txt");
    await copyBuildResources(planned);
    expect(await readFile(resolve(packageRoot, "res/a.txt"), "utf8")).toBe("a");
  });
});
