import { expect, test } from "bun:test";
import {
  auditPackedPackage,
  type PackedPackage,
  pendingOwnerDecisions,
} from "../../scripts/check-release-packages.ts";

const expected = {
  version: "1.2.3",
  names: new Set([
    "@bunaway/core",
    "@bunaway/plugin",
  ]),
};

function packed(overrides: Partial<PackedPackage> = {}): PackedPackage {
  return {
    files: [
      "package.json",
      "LICENSE.txt",
      "src/index.ts",
    ],
    manifest: {
      name: "@bunaway/plugin",
      version: "1.2.3",
      exports: {
        ".": "./src/index.ts",
      },
      dependencies: {
        "@bunaway/core": "1.2.3",
      },
    },
    sources: new Map([
      [
        "src/index.ts",
        'import { core } from "@bunaway/core";\nimport { join } from "node:path";\nexport { core, join };\n',
      ],
    ]),
    ...overrides,
  };
}

test("a complete package passes the audit", () => {
  expect(auditPackedPackage(packed(), expected)).toEqual([]);
});

test("the audit rejects a version that differs from the release", () => {
  const problems = auditPackedPackage(
    packed({
      manifest: {
        ...packed().manifest,
        version: "0.0.0",
      },
    }),
    expected,
  );
  expect(problems.join("\n")).toContain("differs from the release version");
});

test("the audit rejects unpublishable and unpinned internal dependency ranges", () => {
  const manifest = {
    ...packed().manifest,
    dependencies: {
      "@bunaway/core": "workspace:*",
      "@bunaway/ghost": "1.2.3",
    },
  };
  const text = auditPackedPackage(
    packed({
      manifest,
    }),
    expected,
  ).join("\n");
  expect(text).toContain("unpublishable range workspace:*");
  expect(text).toContain("@bunaway/ghost is not published");
});

test("the audit rejects scripts, development dependencies and forbidden files", () => {
  const manifest = {
    ...packed().manifest,
    scripts: {},
    devDependencies: {},
  };
  const text = auditPackedPackage(
    packed({
      manifest,
      files: [
        "package.json",
        "LICENSE.txt",
        "src/index.ts",
        "src/index.test.ts",
        ".env.local",
      ],
    }),
    expected,
  ).join("\n");
  expect(text).toContain("scripts must not be published");
  expect(text).toContain("devDependencies must not be published");
  expect(text).toContain("src/index.test.ts must not be published");
  expect(text).toContain(".env.local must not be published");
});

test("the audit rejects package.json targets missing from the tarball and a missing license", () => {
  const text = auditPackedPackage(
    packed({
      files: [
        "package.json",
      ],
    }),
    expected,
  ).join("\n");
  expect(text).toContain(
    "./src/index.ts named by package.json is not in the tarball",
  );
  expect(text).toContain("has no license file");
});

test("an exports pattern needs a packed match unless the package has no platform adapters", () => {
  const manifest = {
    ...packed().manifest,
    exports: {
      "./native/*": "./dist/native/*.js",
    },
  };
  const plain = [
    "package.json",
    "LICENSE.txt",
    "src/index.ts",
  ];
  const adapters = [
    ...plain,
    "src/platforms/windows.ts",
  ];
  expect(
    auditPackedPackage(
      packed({
        manifest,
        files: [
          ...adapters,
          "dist/native/windows.js",
        ],
      }),
      expected,
    ),
  ).toEqual([]);
  expect(
    auditPackedPackage(
      packed({
        manifest,
        files: plain,
      }),
      expected,
    ),
  ).toEqual([]);
  expect(
    auditPackedPackage(
      packed({
        manifest,
        files: adapters,
      }),
      expected,
    ).join("\n"),
  ).toContain("./dist/native/*.js named by package.json matches no file");
});

test("type-only imports and non-string ranges are audited", () => {
  const manifest = {
    ...packed().manifest,
    dependencies: {
      "@bunaway/core": 1,
    },
  };
  const text = auditPackedPackage(
    packed({
      manifest,
      sources: new Map([
        [
          "src/types.ts",
          'import type { A } from "@bunaway/plugin-api/native";\nexport type { B } from "left-pad";\n',
        ],
      ]),
    }),
    expected,
  ).join("\n");
  expect(text).toContain(
    "dependencies.@bunaway/core is not a version range string",
  );
  expect(text).toContain("imports @bunaway/plugin-api");
  expect(text).toContain("imports left-pad");
});

test("inline import type references, inline type specifiers and comments are handled", () => {
  const text = auditPackedPackage(
    packed({
      manifest: {
        ...packed().manifest,
        dependencies: {},
      },
      sources: new Map([
        [
          "dist/types/a.d.ts",
          'export declare const x: import("pkg-a").T;\nimport { type B } from "pkg-b";\n// import type { C } from "pkg-c"\n/* export type { D } from "pkg-d" */\nconst template = `from "$' +
            '{name}"`;\n',
        ],
      ]),
    }),
    expected,
  ).join("\n");
  expect(text).toContain("imports pkg-a");
  expect(text).toContain("imports pkg-b");
  expect(text).not.toContain("pkg-c");
  expect(text).not.toContain("pkg-d");
  expect(text).not.toContain("{name}");
});

test("file: and link: ranges are rejected like workspace: ranges", () => {
  const manifest = {
    ...packed().manifest,
    dependencies: {
      "@bunaway/core": "file:/tmp/core.tgz",
      "left-pad": "link:../left-pad",
    },
  };
  const text = auditPackedPackage(
    packed({
      manifest,
    }),
    expected,
  ).join("\n");
  expect(text).toContain(
    "dependencies.@bunaway/core keeps the unpublishable range file:",
  );
  expect(text).toContain(
    "dependencies.left-pad keeps the unpublishable range link:",
  );
});

test("the audit rejects an import that package.json does not declare", () => {
  const manifest = {
    ...packed().manifest,
    dependencies: {},
  };
  const text = auditPackedPackage(
    packed({
      manifest,
    }),
    expected,
  ).join("\n");
  expect(text).toContain(
    "imports @bunaway/core, which package.json does not declare",
  );
});

test("values that wait on the repository owner are reported as pending", () => {
  expect(
    pendingOwnerDecisions({
      private: true,
      license: "UNLICENSED",
    }),
  ).toEqual([
    "private is true",
    "license is not decided",
    "publishConfig is not set",
  ]);
  expect(
    pendingOwnerDecisions({
      license: "MIT",
      publishConfig: {},
    }),
  ).toEqual([
    "private is not set, so the package is publishable as is",
  ]);
});
