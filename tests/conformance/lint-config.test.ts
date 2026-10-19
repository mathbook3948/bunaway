import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";

const repository = resolve(import.meta.dir, "../..");
const COMPLEXITY_RULE = "complexity/noExcessiveCognitiveComplexity";
const COMPLEXITY_CATEGORY = `lint/${COMPLEXITY_RULE}`;
/** One Biome run over every exempted file, including the daemon-less startup. */
const LINT_TIMEOUT_MS = 60_000;
/** The placeholder reason every entry started with; it names no function and no cause. */
const GENERIC_REASON =
  "Has functions over the cognitive complexity limit that are not yet split; the count is capped";
/** Entries still carrying the placeholder. Rewrite a reason to lower it; it never rises. */
const GENERIC_REASON_LIMIT = 64;
/** A specific reason names the function and why it stays; shorter text says too little. */
const MIN_REASON_LENGTH = 40;
/** Entries one expiry date may hold, so the baseline never fails all at once. */
const MAX_ENTRIES_PER_EXPIRY = 8;
type ComplexityBaseline = Record<
  string,
  {
    functions: number;
    reason: string;
    /** Who accepted keeping these functions over the limit. */
    approver: string;
    expires: string;
  }
>;

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

async function complexityBaseline(): Promise<ComplexityBaseline> {
  return (await Bun.file(
    resolve(import.meta.dir, "complexity-baseline.json"),
  ).json()) as ComplexityBaseline;
}

/** Functions over the limit per exempted file, from one Biome run with the rule turned back on. */
async function violatingFunctions(
  config: BiomeConfig,
  exemptions: string[],
): Promise<Map<string, number>> {
  const limit =
    config.linter.rules.complexity.noExcessiveCognitiveComplexity.options
      .maxAllowedComplexity;
  // An extending config appends an override, and a later override wins, so this turns the
  // rule back on for exactly the exempted files without editing the repository config. The
  // config must sit inside the repository for its relative `extends` and the VCS root.
  // `--only` alone also re-enables an "off" rule, but with whatever options the base config
  // holds; the explicit override pins the limit the ratchet is meant to check.
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
    // Biome exits 1 when it reports diagnostics, so only an empty report means it failed.
    const stdout = lint.stdout?.toString() ?? "";
    if (lint.exitCode === null || stdout.length === 0) {
      throw new Error(
        `Biome did not report: exit ${lint.exitCode}, ${lint.stderr?.toString() ?? ""}`,
      );
    }
    const report = JSON.parse(stdout) as {
      diagnostics: BiomeDiagnostic[];
    };
    const counts = new Map<string, number>();
    for (const diagnostic of report.diagnostics) {
      if (diagnostic.category !== COMPLEXITY_CATEGORY) {
        continue;
      }
      // Biome reports native separators, so compare in the forward-slash form of biome.json.
      const path = diagnostic.location?.path?.replaceAll("\\", "/");
      if (path !== undefined) {
        counts.set(path, (counts.get(path) ?? 0) + 1);
      }
    }
    return counts;
  } finally {
    await rm(directory, {
      recursive: true,
      force: true,
    });
  }
}

test("every complexity exemption has a baseline entry with a reason and an unexpired date", async () => {
  const exemptions = complexityExemptions(await biomeConfig());
  const baseline = await complexityBaseline();
  // A file exempted without an entry, or an entry without an exemption, is a silent change.
  expect(Object.keys(baseline).sort()).toEqual(
    [
      ...exemptions,
    ].sort(),
  );
  const today = new Date().toISOString().slice(0, 10);
  const invalid: string[] = [];
  const expired: string[] = [];
  const missing: string[] = [];
  for (const [path, entry] of Object.entries(baseline)) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      !Number.isInteger(entry.functions) ||
      entry.functions < 1 ||
      typeof entry.reason !== "string" ||
      entry.reason.trim().length === 0 ||
      typeof entry.approver !== "string" ||
      entry.approver.trim().length === 0 ||
      typeof entry.expires !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(entry.expires)
    ) {
      invalid.push(path);
    } else if (entry.expires < today) {
      expired.push(path);
    }
    // A deleted or renamed file keeps matching nothing, so Biome never reports it.
    const exists = await stat(resolve(repository, path)).then(
      (info) => info.isFile(),
      () => false,
    );
    if (!exists) {
      missing.push(path);
    }
  }
  expect(invalid).toEqual([]);
  expect(missing).toEqual([]);
  // An expired entry needs the functions split or a new, dated reason.
  expect(expired).toEqual([]);
});

test(
  "every exempted file has exactly the baseline number of functions over the complexity limit",
  async () => {
    const config = await biomeConfig();
    const baseline = await complexityBaseline();
    const counts = await violatingFunctions(
      config,
      complexityExemptions(config),
    );
    const drift: string[] = [];
    for (const [path, entry] of Object.entries(baseline)) {
      const actual = counts.get(path) ?? 0;
      if (actual > entry.functions) {
        drift.push(
          `${path}: ${actual} over the limit, baseline ${entry.functions}`,
        );
      } else if (actual < entry.functions) {
        // Lower the number, or drop the file from biome.json and the baseline at zero.
        drift.push(
          `${path}: ${actual} over the limit, lower the baseline from ${entry.functions}`,
        );
      }
    }
    expect(drift).toEqual([]);
  },
  LINT_TIMEOUT_MS,
);

test("baseline reasons are specific, distinct and the placeholder count only shrinks", async () => {
  const baseline = await complexityBaseline();
  const generic: string[] = [];
  const tooShort: string[] = [];
  const seen = new Map<string, string>();
  const duplicated: string[] = [];
  for (const [path, entry] of Object.entries(baseline)) {
    const reason = entry.reason.trim();
    if (reason === GENERIC_REASON) {
      generic.push(path);
      continue;
    }
    if (reason.length < MIN_REASON_LENGTH) {
      tooShort.push(path);
    }
    const first = seen.get(reason);
    if (first === undefined) {
      seen.set(reason, path);
    } else {
      duplicated.push(`${path} repeats the reason of ${first}`);
    }
  }
  expect(tooShort).toEqual([]);
  expect(duplicated).toEqual([]);
  // Replace a placeholder with the real cause and lower GENERIC_REASON_LIMIT.
  expect(generic.length).toBeLessThanOrEqual(GENERIC_REASON_LIMIT);
  if (generic.length < GENERIC_REASON_LIMIT) {
    throw new Error(
      `${generic.length} placeholder reasons remain, lower GENERIC_REASON_LIMIT from ${GENERIC_REASON_LIMIT}`,
    );
  }
});

test("baseline expiry dates are spread over several days", async () => {
  const baseline = await complexityBaseline();
  const perDate = new Map<string, number>();
  for (const entry of Object.values(baseline)) {
    perDate.set(entry.expires, (perDate.get(entry.expires) ?? 0) + 1);
  }
  const crowded = [
    ...perDate,
  ]
    .filter(([, count]) => count > MAX_ENTRIES_PER_EXPIRY)
    .map(([date, count]) => `${date}: ${count} entries`);
  expect(crowded).toEqual([]);
});

test("baseline entries are one line each, sorted by file path", async () => {
  const text = await Bun.file(
    resolve(import.meta.dir, "complexity-baseline.json"),
  ).text();
  const lines = text.trimEnd().split("\n");
  expect(lines[0]).toBe("{");
  expect(lines[lines.length - 1]).toBe("}");
  const paths: string[] = [];
  const malformed: string[] = [];
  for (const line of lines.slice(1, -1)) {
    const match = /^ {2}("[^"]+"): \{.*\},?$/.exec(line);
    if (match === null) {
      malformed.push(line);
    } else {
      paths.push(JSON.parse(match[1] as string) as string);
    }
  }
  expect(malformed).toEqual([]);
  expect(paths).toEqual(
    [
      ...paths,
    ].sort(),
  );
});

/**
 * Strictness and module settings tsconfig.base.json owns; a workspace tsconfig must not restate
 * or weaken them. `lib` and `types` stay overridable for browser-only packages.
 */
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
    expect(base, path).toBe(resolve(repository, "tsconfig.base.json"));
    const restated = Object.keys(config.compilerOptions ?? {}).filter((key) =>
      BASE_OWNED_OPTIONS.includes(key),
    );
    expect(restated, path).toEqual([]);
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
