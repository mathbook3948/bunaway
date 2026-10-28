import { afterEach, beforeEach, expect, test } from "bun:test";
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
import { join } from "node:path";
import type { Release } from "#cli/distribution";
import { main } from "#cli/main";
import { applyUpgrade, planUpgrade, upgradeProject } from "#cli/upgrade";

const target: Release = {
  format: 1,
  version: "2.0.0",
  packages: {
    cli: "@bunaway/cli",
    "backend-sdk": "@bunaway/backend",
  },
  plugins: {
    opener: "@bunaway/plugin-opener",
  },
  webProtocol: {
    major: 1,
    minor: 0,
  },
  processProtocol: {
    major: 1,
    minor: 0,
  },
  nativeHost: "2.0.0",
  bun: "1.4.2",
};

let project: string;

async function writePackage(text: string): Promise<void> {
  await writeFile(join(project, "package.json"), text);
}

async function install(name: string, version: string): Promise<void> {
  const directory = join(project, "node_modules", ...name.split("/"));
  await mkdir(directory, {
    recursive: true,
  });
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({
      name,
      version,
    }),
  );
}

function manifest(overrides: Record<string, unknown> = {}): string {
  return `${JSON.stringify(
    {
      name: "app",
      dependencies: {
        "@bunaway/cli": "1.0.0",
        left: "^1.0.0",
      },
      devDependencies: {
        "@bunaway/backend": "~1.0.0",
      },
      packageManager: "bun@1.3.0",
      ...overrides,
    },
    null,
    2,
  )}\n`;
}

async function quiet<T>(run: () => Promise<T>): Promise<T> {
  const original = console.log;
  console.log = () => {};
  try {
    return await run();
  } finally {
    console.log = original;
  }
}

beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), "bunaway-upgrade-"));
});

afterEach(async () => {
  await rm(project, {
    recursive: true,
    force: true,
  });
});

test("a project that already matches is reported as up to date and not rewritten", async () => {
  const text = manifest({
    dependencies: {
      "@bunaway/cli": "2.0.0",
    },
    devDependencies: {
      "@bunaway/backend": "2.0.0",
    },
    packageManager: "bun@1.4.2",
  });
  await writePackage(text);
  await install("@bunaway/cli", "2.0.0");
  await install("@bunaway/backend", "2.0.0");
  expect(await quiet(() => upgradeProject(project, false, target))).toBe(0);
  expect(await quiet(() => upgradeProject(project, true, target))).toBe(0);
  expect(await readFile(join(project, "package.json"), "utf8")).toBe(text);
});

test("check mode lists changes, exits 1 and leaves no file changes", async () => {
  const text = manifest();
  await writePackage(text);
  expect(await quiet(() => upgradeProject(project, false, target))).toBe(1);
  expect(await readFile(join(project, "package.json"), "utf8")).toBe(text);
  expect(await readdir(project)).toEqual([
    "package.json",
  ]);
});

test("write pins dependencies, packageManager and engines.bun and keeps other keys", async () => {
  await writePackage(
    manifest({
      engines: {
        bun: ">=1.0.0",
      },
      optionalDependencies: {
        "@bunaway/plugin-opener": "^1.0.0",
      },
    }),
  );
  expect(await quiet(() => upgradeProject(project, true, target))).toBe(0);
  const result = JSON.parse(
    await readFile(join(project, "package.json"), "utf8"),
  );
  expect(result).toEqual({
    name: "app",
    dependencies: {
      "@bunaway/cli": "2.0.0",
      left: "^1.0.0",
    },
    devDependencies: {
      "@bunaway/backend": "2.0.0",
    },
    packageManager: "bun@1.4.2",
    engines: {
      bun: "1.4.2",
    },
    optionalDependencies: {
      "@bunaway/plugin-opener": "2.0.0",
    },
  });
  expect(Object.keys(result).slice(0, 3)).toEqual([
    "name",
    "dependencies",
    "devDependencies",
  ]);
  expect(await readdir(project)).toEqual([
    "package.json",
  ]);
});

test("write keeps indentation, line endings, BOM and a missing final newline", async () => {
  const cases = [
    (text: string) => text.replaceAll("  ", "\t"),
    (text: string) => text.replaceAll("\n", "\r\n"),
    (text: string) => text.trimEnd(),
    (text: string) => `﻿${text}`,
    (text: string) => text.replaceAll("  ", "    "),
  ];
  for (const variant of cases) {
    const text = variant(manifest());
    await writePackage(text);
    await quiet(() => upgradeProject(project, true, target));
    const written = await readFile(join(project, "package.json"), "utf8");
    expect(written).toBe(
      variant(
        manifest({
          dependencies: {
            "@bunaway/cli": "2.0.0",
            left: "^1.0.0",
          },
          devDependencies: {
            "@bunaway/backend": "2.0.0",
          },
          packageManager: "bun@1.4.2",
        }),
      ),
    );
  }
});

test("workspace, link and file specifiers are skipped and left as they are", async () => {
  await writePackage(
    manifest({
      dependencies: {
        "@bunaway/cli": "workspace:*",
        "@bunaway/backend": "file:../backend.tgz",
      },
      devDependencies: {
        "@bunaway/plugin-opener": "link:../opener",
      },
    }),
  );
  const plan = await planUpgrade(project, target);
  expect(plan.lines.filter((line) => line.status === "SKIP").length).toBe(3);
  await quiet(() => upgradeProject(project, true, target));
  const result = JSON.parse(
    await readFile(join(project, "package.json"), "utf8"),
  );
  expect(result.dependencies["@bunaway/cli"]).toBe("workspace:*");
  expect(result.devDependencies["@bunaway/plugin-opener"]).toBe(
    "link:../opener",
  );
});

test("unknown framework packages and overrides fail and block the write", async () => {
  for (const extra of [
    {
      dependencies: {
        "@bunaway/unknown": "1.0.0",
        "@bunaway/cli": "1.0.0",
      },
    },
    {
      overrides: {
        "@bunaway/cli": "1.0.0",
      },
    },
  ]) {
    const text = manifest(extra);
    await writePackage(text);
    expect(await quiet(() => upgradeProject(project, true, target))).toBe(1);
    expect(await readFile(join(project, "package.json"), "utf8")).toBe(text);
  }
});

test("an installed version that differs from the target fails the check", async () => {
  await writePackage(
    manifest({
      dependencies: {
        "@bunaway/cli": "2.0.0",
      },
      devDependencies: {},
      packageManager: "bun@1.4.2",
    }),
  );
  await install("@bunaway/cli", "1.0.0");
  const plan = await planUpgrade(project, target);
  expect(plan.lines.find((line) => line.name.startsWith("installed"))).toEqual({
    status: "FAIL",
    name: "installed @bunaway/cli",
    detail: "1.0.0 is installed; run bun install after the update",
  });
  expect(await quiet(() => upgradeProject(project, false, target))).toBe(1);
});

test("an optional dependency that is not installed passes", async () => {
  await writePackage(
    manifest({
      dependencies: {},
      devDependencies: {},
      optionalDependencies: {
        "@bunaway/plugin-opener": "2.0.0",
      },
      packageManager: "bun@1.4.2",
    }),
  );
  expect(await quiet(() => upgradeProject(project, false, target))).toBe(0);
});

test("a package.json link is refused", async () => {
  if (process.platform === "win32") {
    return;
  }
  await writeFile(join(project, "real.json"), manifest());
  await symlink("real.json", join(project, "package.json"));
  await expect(planUpgrade(project, target)).rejects.toThrow("regular file");
});

test("a package.json that changed after planning is not overwritten", async () => {
  await writePackage(manifest());
  const plan = await planUpgrade(project, target);
  const edited = manifest({
    name: "edited",
  });
  await writePackage(edited);
  await expect(applyUpgrade(project, plan)).rejects.toThrow("changed");
  expect(await readFile(join(project, "package.json"), "utf8")).toBe(edited);
  expect(await readdir(project)).toEqual([
    "package.json",
  ]);
});

test("a rewrite that would alter the file's formatting is refused and writes nothing", async () => {
  const stale = `"@bunaway/cli": "1.0.0"`;
  const variants = [
    // Duplicate key: the rewrite would drop the first value.
    `{\n  "name": "a",\n  "name": "b",\n  "dependencies": { ${stale} }\n}\n`,
    // Number spelling, escape sequence and inline spacing are normalized by JSON.stringify.
    `{\n  "version": 1.0,\n  "dependencies": {\n    ${stale}\n  }\n}\n`,
    `{\n  "author": "\\u00e9",\n  "dependencies": {\n    ${stale}\n  }\n}\n`,
    `{ "dependencies": { ${stale} } }\n`,
    // Integer-like keys are reordered by the engine.
    `{\n  "2": 1,\n  "1": 2,\n  "dependencies": {\n    ${stale}\n  }\n}\n`,
  ];
  for (const text of variants) {
    await writePackage(text);
    expect(await quiet(() => upgradeProject(project, true, target))).toBe(1);
    expect(await readFile(join(project, "package.json"), "utf8")).toBe(text);
    expect(await readdir(project)).toEqual([
      "package.json",
    ]);
  }
});

test("a package.json with invalid UTF-8 bytes is refused and keeps its bytes", async () => {
  const bytes = Buffer.concat([
    Buffer.from('{\n  "author": "'),
    Buffer.from([
      0xe9,
    ]),
    Buffer.from(
      '",\n  "dependencies": {\n    "@bunaway/cli": "1.0.0"\n  }\n}\n',
    ),
  ]);
  await writeFile(join(project, "package.json"), bytes);
  await expect(upgradeProject(project, true, target)).rejects.toThrow("UTF-8");
  expect(await readFile(join(project, "package.json"))).toEqual(bytes);
});

test("a local package file is skipped and its installed version is not compared", async () => {
  await writePackage(
    manifest({
      dependencies: {
        "@bunaway/cli": "file:/packs/bunaway-cli-1.0.0.tgz",
      },
      devDependencies: {},
      packageManager: "bun@1.4.2",
    }),
  );
  await install("@bunaway/cli", "1.0.0");
  const plan = await planUpgrade(project, target);
  expect(plan.lines.map((line) => line.status)).toEqual([
    "SKIP",
    "OK",
  ]);
  expect(await quiet(() => upgradeProject(project, false, target))).toBe(0);
});

test("the command rejects unknown options and extra directories", async () => {
  await expect(
    main([
      "upgrade",
      "-w",
    ]),
  ).rejects.toThrow("Usage");
  await expect(
    main([
      "upgrade",
      "--force",
    ]),
  ).rejects.toThrow("Usage");
  await expect(
    main([
      "upgrade",
      "a",
      "b",
    ]),
  ).rejects.toThrow("Usage");
  await expect(
    main([
      "upgrade",
      "--write",
      "--write",
    ]),
  ).rejects.toThrow("Usage");
});

test("git shorthand, relative path and bare tarball specifiers are skipped", async () => {
  await writePackage(
    manifest({
      dependencies: {
        "@bunaway/cli": "someorg/bunaway-cli#main",
        "@bunaway/backend": "../vendor/backend",
        "@bunaway/plugin-opener": "bunaway-opener-1.0.0.tar.gz",
      },
      devDependencies: {},
    }),
  );
  const plan = await planUpgrade(project, target);
  expect(plan.lines.filter((line) => line.status === "SKIP").length).toBe(3);
  await quiet(() => upgradeProject(project, true, target));
  const result = JSON.parse(
    await readFile(join(project, "package.json"), "utf8"),
  );
  expect(result.dependencies["@bunaway/cli"]).toBe("someorg/bunaway-cli#main");
  expect(result.dependencies["@bunaway/backend"]).toBe("../vendor/backend");
  expect(result.dependencies["@bunaway/plugin-opener"]).toBe(
    "bunaway-opener-1.0.0.tar.gz",
  );
});

test("an unreadable installed package.json is reported as a failure", async () => {
  await writePackage(
    manifest({
      dependencies: {
        "@bunaway/cli": "2.0.0",
      },
      devDependencies: {},
      packageManager: "bun@1.4.2",
    }),
  );
  await install("@bunaway/cli", "1.0.0");
  await writeFile(
    join(project, "node_modules", "@bunaway", "cli", "package.json"),
    "not json",
  );
  const plan = await planUpgrade(project, target);
  const line = plan.lines.find((entry) => entry.name.startsWith("installed"));
  expect(line?.status).toBe("FAIL");
  expect(line?.detail).toContain("cannot read the installed package");
  expect(await quiet(() => upgradeProject(project, false, target))).toBe(1);
});
