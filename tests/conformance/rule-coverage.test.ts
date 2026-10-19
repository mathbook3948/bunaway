import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const SOURCE_ROOTS = [
  "packages",
  "plugins",
  "native",
  "scripts",
];
/** Code quality sections whose rules the table covers with a row that starts "<section>:". */
const TABLE_SECTIONS = [
  "Naming and readability",
  "Errors and resource lifetime",
  "Efficiency",
  "Review and refactoring discipline",
];
/** A handler that swallows an error with an empty body and no comment saying why. */
const EMPTY_HANDLER =
  /\.catch\(\s*\(\)\s*=>\s*\{\s*\}\s*\)|\bcatch\s*(?:\([^)]*\))?\s*\{\s*\}/g;

/**
 * Production files that still swallow an error with an empty handler, with how many. Each count
 * only goes down: giving a handler a recovery, a log or a comment naming the reason lowers it, and
 * a file that reaches zero leaves the list. A new file, or a new empty handler in a listed file,
 * fails.
 */
const EMPTY_HANDLERS: Record<string, number> = {
  "native/macos/bun/backend.ts": 2,
  "native/macos/bun/entry.ts": 1,
  "native/macos/bun/process-group.ts": 1,
  "native/macos/bun/webview.ts": 1,
  "native/windows/bun/boot.ts": 2,
  "native/windows/bun/desktop.ts": 1,
  "native/windows/bun/entry.ts": 2,
  "packages/cli/src/dev-server.ts": 1,
  "packages/cli/src/managed-command.ts": 1,
  "packages/cli/src/sdk.ts": 1,
  "packages/cli/src/windows-app-reload.ts": 1,
  "packages/core/src/create-core.ts": 1,
  "packages/runtime-bun/src/diagnostic-log.ts": 1,
  "packages/runtime-bun/src/runtime.ts": 2,
};

async function tableRows(): Promise<string[]> {
  const text = await Bun.file(resolve(root, "AGENTS.md")).text();
  const start = text.indexOf("### Rules and what enforces them");
  const end = text.indexOf("\n### ", start + 1);
  return text
    .slice(start, end)
    .split("\n")
    .filter((line) => line.startsWith("| ") && !line.startsWith("| ---"));
}

async function productionSources(): Promise<string[]> {
  const files: string[] = [];
  for (const base of SOURCE_ROOTS) {
    for await (const file of new Bun.Glob("**/*.{ts,tsx}").scan({
      cwd: resolve(root, base),
    })) {
      const path = `${base}/${file.replaceAll("\\", "/")}`;
      if (!/(^|\/)(node_modules|dist|vendor|build)\//.test(path)) {
        files.push(path);
      }
    }
  }
  return files.sort();
}

test("every Code quality section named here has a rules table row", async () => {
  const rows = await tableRows();
  for (const section of TABLE_SECTIONS) {
    expect(rows.some((row) => row.startsWith(`| ${section}: `))).toBe(true);
  }
});

test("every file the rules table names as a check exists", async () => {
  const missing: string[] = [];
  for (const row of await tableRows()) {
    const enforcement = row.split(" | ").slice(1).join(" | ");
    for (const match of enforcement.matchAll(
      /`((?:tests|scripts|docs|packages|plugins|native)\/[^`\s]+\.[a-z]+)`/g,
    )) {
      if (!existsSync(resolve(root, match[1] ?? ""))) {
        missing.push(match[1] ?? "");
      }
    }
  }
  expect(missing).toEqual([]);
});

test("production code does not swallow errors with an empty handler", async () => {
  const found: Record<string, number> = {};
  for (const file of await productionSources()) {
    const text = await Bun.file(resolve(root, file)).text();
    const count = text.match(EMPTY_HANDLER)?.length ?? 0;
    if (count > 0) {
      found[file] = count;
    }
  }
  expect(found).toEqual(EMPTY_HANDLERS);
});
