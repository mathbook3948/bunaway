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

test("an exports pattern must resolve to the Windows adapter unless the plugin ships none", () => {
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
  const withWindows = packed({
    manifest,
    files: [
      ...plain,
      "dist/native/windows.js",
    ],
  });
  const withMacosOnly = packed({
    manifest,
    files: [
      ...plain,
      "dist/native/macos.js",
    ],
  });
  expect(auditPackedPackage(withWindows, expected)).toEqual([]);
  // A non-native pattern needs any match, and loose main, bin and plugin entries are checked.
  const entries = packed({
    manifest: {
      ...packed().manifest,
      main: "dist/index.js",
      bunaway: {
        plugin: "dist/plugin.js",
      },
      imports: {
        "#x/*": {
          types: "./dist/types/*.d.ts",
          default: "./src/*.ts",
        },
      },
    },
  });
  const entryProblems = auditPackedPackage(entries, expected).join("\n");
  expect(entryProblems).toContain("./dist/index.js named by package.json");
  expect(entryProblems).toContain("./dist/plugin.js named by package.json");
  expect(entryProblems).toContain(
    "./dist/types/*.d.ts named by package.json matches no file",
  );
  expect(auditPackedPackage(withMacosOnly, expected).join("\n")).toContain(
    "names dist/native/windows.js, which is not in the tarball",
  );
  const windowState = {
    ...packed({
      manifest: {
        ...manifest,
        name: "@bunaway/plugin-window-state",
      },
      files: plain,
    }),
  };
  expect(
    auditPackedPackage(windowState, {
      ...expected,
      names: new Set([
        "@bunaway/plugin-window-state",
        "@bunaway/core",
      ]),
    }),
  ).toEqual([]);
});

test("the adapter exemption keeps checking other targets, loose bin entries and all source extensions", () => {
  const windowState = packed({
    manifest: {
      ...packed().manifest,
      name: "@bunaway/plugin-window-state",
      bin: "cli.js",
      exports: {
        "./native/*": "./dist/native/*.js",
        ".": "./dist/index.js",
      },
    },
    sources: new Map([
      [
        "src/a.cts",
        'import x from "pkg-cts";',
      ],
      [
        "src/b.jsx",
        'import y from "pkg-jsx";',
      ],
      [
        "src/c.cjs",
        'const z = require("pkg-cjs");',
      ],
    ]),
  });
  const text = auditPackedPackage(windowState, {
    ...expected,
    names: new Set([
      "@bunaway/plugin-window-state",
    ]),
  }).join("\n");
  expect(text).toContain("./dist/index.js named by package.json");
  expect(text).toContain("./cli.js named by package.json");
  expect(text).not.toContain("dist/native");
  for (const missing of [
    "pkg-cts",
    "pkg-jsx",
    "pkg-cjs",
  ]) {
    expect(text).toContain(`imports ${missing}`);
  }
});

test("Node builtins need no declaration but packages that Bun lists as builtins do", () => {
  const audit = (source: string) =>
    auditPackedPackage(
      packed({
        manifest: {
          ...packed().manifest,
          dependencies: {},
        },
        sources: new Map([
          [
            "dist/index.js",
            source,
          ],
        ]),
      }),
      expected,
    ).join("\n");
  expect(audit('import fs from "fs"; import { join } from "path/posix";')).toBe(
    "",
  );
  expect(audit('import { WebSocket } from "ws";')).toContain("imports ws");
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

test("glob strings, trailing comments and string text do not hide or invent imports", () => {
  const audit = (source: string) =>
    auditPackedPackage(
      packed({
        manifest: {
          ...packed().manifest,
          dependencies: {},
        },
        sources: new Map([
          [
            "src/a.ts",
            source,
          ],
        ]),
      }),
      expected,
    ).join("\n");
  expect(
    audit(
      'const g = "dist/*";\nimport type { X } from "pkg-hidden";\nconst h = "*/";',
    ),
  ).toContain("imports pkg-hidden");
  expect(
    audit(
      '// match src/*.ts\nimport type { X } from "pkg-hidden2";\n/** doc */',
    ),
  ).toContain("imports pkg-hidden2");
  expect(audit('const a = 1; // copied from "pkg-trailing"')).toBe("");
  expect(audit("throw new Error(\"cannot load from 'config'\");")).toBe("");
  expect(audit('const t = `import x from "react"`;')).toBe("");
});

test("regular expression and nested template literals do not hide or invent imports", () => {
  const audit = (source: string) =>
    auditPackedPackage(
      packed({
        manifest: {
          ...packed().manifest,
          dependencies: {},
        },
        sources: new Map([
          [
            "src/a.ts",
            source,
          ],
        ]),
      }),
      expected,
    ).join("\n");
  // Built from parts so the lint rule against placeholder-looking strings does not apply.
  const open = "$" + "{";
  const nestedTemplate = `const m = \`x ${open}\`it's\`}\`;`;
  const quotedBacktick = `const s = \`a${open}"\`"}b\`;`;
  const hidden = 'export type T = import("pkg-hidden").T;\n';
  expect(audit(`const re = /["]/;\n${hidden}const q = "x";`)).toContain(
    "imports pkg-hidden",
  );
  expect(audit(`const re = /^src\\/*/;\n${hidden}/* end */`)).toContain(
    "imports pkg-hidden",
  );
  expect(audit(`const re = /a\\//;\n${hidden}`)).toContain(
    "imports pkg-hidden",
  );
  expect(
    audit(`const re = /[/"]/;\nconst msg = "cannot load from 'config'";`),
  ).toBe("");
  expect(audit(`${nestedTemplate}\n${hidden}const q = 'q';`)).toContain(
    "imports pkg-hidden",
  );
  expect(audit(`${quotedBacktick}\n${hidden}const q = "x";`)).toContain(
    "imports pkg-hidden",
  );
  expect(
    audit(`const half = total / 2; const x = a / b;\n${hidden}`),
  ).toContain("imports pkg-hidden");
  expect(
    audit('const a = loader.import("theme-dark"); ctx.require("config");'),
  ).toBe("");
  expect(audit(`const m = \`${open}/"/.test(s)}\`;\n${hidden}`)).toContain(
    "imports pkg-hidden",
  );
  expect(
    audit(`const m = \`${open}/"/.test(s)}\`;\nconst q = "from 'pkg-fake'";`),
  ).toBe("");
  expect(audit("type X = typeof import(`pkg-tpl`);")).toBe("");
});

test("the import scan stays linear on a large source", () => {
  const source = 'const a = "x" + b;\n'.repeat(60_000);
  const started = performance.now();
  auditPackedPackage(
    packed({
      sources: new Map([
        [
          "src/big.ts",
          source,
        ],
      ]),
    }),
    expected,
  );
  expect(performance.now() - started).toBeLessThan(5000);
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
  expect(
    pendingOwnerDecisions({
      private: false,
      license: "MIT",
      publishConfig: {},
    }),
  ).toEqual([]);
});
