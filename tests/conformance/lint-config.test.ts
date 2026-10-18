import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";

const repository = resolve(import.meta.dir, "../..");
const COMPLEXITY_RULE = "complexity/noExcessiveCognitiveComplexity";
const COMPLEXITY_CATEGORY = `lint/${COMPLEXITY_RULE}`;
/** One Biome run over every exempted file, including the daemon-less startup. */
const LINT_TIMEOUT_MS = 60_000;
/**
 * How many files biome.json may exempt from the complexity rule. Lower it when an exemption is
 * removed; it never goes up, so a new file cannot join the list.
 */
const MAX_COMPLEXITY_EXEMPTIONS = 64;

type BiomeOverride = {
  includes: string[];
  linter?: {
    rules?: {
      complexity?: {
        noExcessiveCognitiveComplexity?: unknown;
      };
    };
  };
};

type BiomeConfig = {
  linter: {
    rules: {
      complexity: {
        noExcessiveCognitiveComplexity: {
          options: {
            maxAllowedComplexity: number;
          };
        };
      };
    };
  };
  overrides: BiomeOverride[];
};

type BiomeDiagnostic = {
  category: string;
  location?: {
    path?: string;
  };
};

async function biomeConfig(): Promise<BiomeConfig> {
  return (await Bun.file(
    resolve(repository, "biome.json"),
  ).json()) as BiomeConfig;
}

/** The files biome.json exempts from the cognitive complexity rule. */
function complexityExemptions(config: BiomeConfig): string[] {
  const exempting = config.overrides.filter(
    (override) =>
      override.linter?.rules?.complexity?.noExcessiveCognitiveComplexity ===
      "off",
  );
  expect(exempting).toHaveLength(1);
  return exempting[0]?.includes ?? [];
}

test("the complexity exemptions never grow and every entry names an existing file", async () => {
  const exemptions = complexityExemptions(await biomeConfig());
  expect(exemptions.length).toBeLessThanOrEqual(MAX_COMPLEXITY_EXEMPTIONS);
  const missing: string[] = [];
  for (const path of exemptions) {
    // A deleted or renamed file keeps matching nothing, so Biome never reports it.
    const exists = await stat(resolve(repository, path)).then(
      (info) => info.isFile(),
      () => false,
    );
    if (!exists) {
      missing.push(path);
    }
  }
  expect(missing).toEqual([]);
});

test(
  "every complexity exemption still fails the rule it is exempted from",
  async () => {
    const config = await biomeConfig();
    const exemptions = complexityExemptions(config);
    const limit =
      config.linter.rules.complexity.noExcessiveCognitiveComplexity.options
        .maxAllowedComplexity;
    // An extending config appends an override, and a later override wins, so this turns the
    // rule back on for exactly the exempted files without editing the repository config. The
    // config must sit inside the repository for its relative `extends` and the VCS root.
    await mkdir(resolve(repository, "build"), {
      recursive: true,
    });
    const directory = await mkdtemp(
      resolve(repository, "build/lint-config-ratchet-"),
    );
    try {
      await Bun.write(
        resolve(directory, "biome.json"),
        JSON.stringify({
          root: false,
          extends: [
            `${relative(directory, repository).replaceAll("\\", "/")}/biome.json`,
          ],
          overrides: [
            {
              includes: exemptions,
              linter: {
                rules: {
                  complexity: {
                    noExcessiveCognitiveComplexity: {
                      level: "error",
                      options: {
                        maxAllowedComplexity: limit,
                      },
                    },
                  },
                },
              },
            },
          ],
        }),
      );
      const lint = Bun.spawnSync(
        [
          process.execPath,
          "x",
          "--no-install",
          "biome",
          "lint",
          `--config-path=${resolve(directory, "biome.json")}`,
          `--only=${COMPLEXITY_RULE}`,
          "--max-diagnostics=1000",
          "--reporter=json",
          ...exemptions,
        ],
        {
          cwd: repository,
          stdout: "pipe",
          stderr: "pipe",
          timeout: LINT_TIMEOUT_MS,
        },
      );
      const report = JSON.parse(lint.stdout.toString()) as {
        diagnostics: BiomeDiagnostic[];
      };
      const violating = new Set(
        report.diagnostics
          .filter((diagnostic) => diagnostic.category === COMPLEXITY_CATEGORY)
          // Biome reports native separators, so compare in the forward-slash form of biome.json.
          .map((diagnostic) =>
            diagnostic.location?.path?.replaceAll("\\", "/"),
          ),
      );
      // A file that passes the rule no longer needs its exemption: remove it from biome.json.
      expect(exemptions.filter((path) => !violating.has(path))).toEqual([]);
    } finally {
      await rm(directory, {
        recursive: true,
        force: true,
      });
    }
  },
  LINT_TIMEOUT_MS,
);

/** Settings tsconfig.base.json owns; a workspace tsconfig must not restate or weaken them. */
const BASE_OWNED_OPTIONS = [
  "strict",
  "noUncheckedIndexedAccess",
  "exactOptionalPropertyTypes",
  "noImplicitOverride",
  "noFallthroughCasesInSwitch",
  "verbatimModuleSyntax",
  "target",
  "module",
  "moduleResolution",
];

type Tsconfig = {
  extends?: string;
  compilerOptions?: Record<string, unknown>;
};

async function workspaceTsconfigs(): Promise<string[]> {
  const glob = new Bun.Glob("{packages,plugins}/*/tsconfig.json");
  const paths = await Array.fromAsync(
    glob.scan({
      cwd: repository,
    }),
  );
  return [
    ...paths,
    "tests/tsconfig.json",
  ].sort();
}

test("every workspace tsconfig extends the base and leaves its strictness alone", async () => {
  const paths = await workspaceTsconfigs();
  expect(paths.length).toBeGreaterThan(20);
  for (const path of paths) {
    const config = (await Bun.file(
      resolve(repository, path),
    ).json()) as Tsconfig;
    const base = resolve(repository, path, "..", config.extends ?? "");
    expect(`${path} extends ${base}`).toBe(
      `${path} extends ${resolve(repository, "tsconfig.base.json")}`,
    );
    const restated = Object.keys(config.compilerOptions ?? {}).filter((key) =>
      BASE_OWNED_OPTIONS.includes(key),
    );
    expect(`${path}: ${restated.join(", ")}`).toBe(`${path}: `);
  }
});

test("the client SDK is typed for browsers only", async () => {
  // WebView code must not see Bun or Node globals during typecheck; that is how a Buffer use
  // in shared code goes unnoticed until the bundle loads in a real WebView.
  const config = (await Bun.file(
    resolve(repository, "packages/client-sdk/tsconfig.json"),
  ).json()) as Tsconfig;
  expect(config.compilerOptions?.types).toEqual([]);
  expect(config.compilerOptions?.lib).toContain("DOM");
});
