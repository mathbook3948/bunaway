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
/** The body of a promise handler that discards the error: empty, or only a nothing value. */
const DISCARDING_BODY = String.raw`(?:\{\s*\}|undefined|null|void\s+0)`;
/** A function that discards its error: empty, or only a nothing value. */
const DISCARDING_FUNCTION = [
  // () => {}, (_) => {}, (e: unknown) => undefined, e => null, async () => {}
  String.raw`(?:async\s*)?(?:\([^()]*\)|[\w$]+)\s*=>\s*${DISCARDING_BODY}`,
  // function () {}, function (e) {}
  String.raw`(?:async\s+)?function\s*\w*\s*\([^()]*\)\s*\{\s*\}`,
].join("|");
/** A handler that swallows an error with an empty body and no comment saying why. */
const EMPTY_HANDLER = new RegExp(
  [
    String.raw`\.catch\(\s*(?:${DISCARDING_FUNCTION})\s*\)`,
    // try { ... } catch {}, catch (e) {}
    String.raw`\bcatch\s*(?:\([^)]*\))?\s*\{\s*\}`,
  ].join("|"),
  "g",
);
const DISCARDING_ARGUMENT = new RegExp(`^(?:${DISCARDING_FUNCTION})$`);

/**
 * The index of the last character of the string, template literal or comment that starts at `i`,
 * or `i` when none starts there. -1 when it never ends.
 */
function skipLiteral(text: string, i: number): number {
  const ch = text[i];
  if (ch === '"' || ch === "'" || ch === "`") {
    let j = i + 1;
    while (j < text.length && text[j] !== ch) {
      j += text[j] === "\\" ? 2 : 1;
    }
    return j < text.length ? j : -1;
  }
  if (ch === "/" && text[i + 1] === "/") {
    return text.indexOf("\n", i);
  }
  if (ch === "/" && text[i + 1] === "*") {
    const end = text.indexOf("*/", i + 2);
    return end < 0 ? -1 : end + 1;
  }
  return i;
}

/**
 * The arguments of the call whose "(" is at `open`, split at top-level commas. Strings, template
 * literals and comments are skipped so a bracket or comma inside them does not count.
 */
function callArguments(text: string, open: number): string[] {
  const args: string[] = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open; i < text.length; i++) {
    const skipped = skipLiteral(text, i);
    if (skipped < 0) {
      break;
    }
    i = skipped;
    const ch = text[i];
    if (ch === "(" || ch === "[" || ch === "{") {
      depth++;
    } else if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) {
        args.push(text.slice(start, i));
        break;
      }
    } else if (ch === "," && depth === 1) {
      args.push(text.slice(start, i));
      start = i + 1;
    }
  }
  return args;
}

/** How many places discard an error with an empty handler. */
function countEmptyHandlers(text: string): number {
  let count = text.match(EMPTY_HANDLER)?.length ?? 0;
  // .then(ok, () => {}): the second argument is the rejection handler.
  for (const match of text.matchAll(/\.then\(/g)) {
    const rejection = callArguments(text, match.index + match[0].length - 1)[1];
    if (rejection !== undefined && DISCARDING_ARGUMENT.test(rejection.trim())) {
      count++;
    }
  }
  return count;
}

/**
 * Production files that still swallow an error with an empty handler, with how many. Each count
 * only goes down: giving a handler a recovery, a log or a comment naming the reason lowers it, and
 * a file that reaches zero leaves the list. A new file, or a new empty handler in a listed file,
 * fails.
 */
const EMPTY_HANDLERS: Record<string, number> = {
  "native/macos/bun/backend.ts": 3,
  "native/macos/bun/entry.ts": 1,
  "native/macos/bun/process-group.ts": 1,
  "native/macos/bun/webview.ts": 1,
  "native/windows/bun/boot.ts": 2,
  "native/windows/bun/desktop.ts": 1,
  "native/windows/bun/entry.ts": 2,
  "packages/cli/src/dev-server.ts": 1,
  "packages/cli/src/managed-command.ts": 1,
  "packages/client-sdk/src/index.ts": 4,
  "packages/core/src/create-core.ts": 1,
  "packages/packaging/src/inputs.ts": 2,
  "packages/packaging/src/runner.ts": 1,
  "packages/runtime-bun/src/runtime.ts": 3,
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
    const count = countEmptyHandlers(text);
    if (count > 0) {
      found[file] = count;
    }
  }
  expect(found).toEqual(EMPTY_HANDLERS);
});

test("the empty handler check flags every form that discards an error", () => {
  const swallowing = [
    "p.catch(() => {})",
    "p.catch((_) => {})",
    "p.catch((e) => {})",
    "p.catch((e: unknown) => {})",
    "p.catch(e => {})",
    "p.catch(async () => {})",
    "p.catch(() => undefined)",
    "p.catch(() => null)",
    "p.catch((e) => void 0)",
    "p.catch(function () {})",
    "p.catch(function (e) {})",
    "try { run(); } catch {}",
    "try { run(); } catch (e) {}",
    "try { run(); } catch (e) {\n}",
  ];
  for (const source of swallowing) {
    expect(countEmptyHandlers(source)).toBe(1);
  }
});

test("the empty handler check flags a then rejection handler that discards the error", () => {
  const swallowing: [
    string,
    number,
  ][] = [
    [
      "p.then(ok, () => {})",
      1,
    ],
    [
      "p.then(ok, (_) => {})",
      1,
    ],
    [
      "p.then(ok, (e) => {})",
      1,
    ],
    [
      "p.then(ok, (e: unknown) => {})",
      1,
    ],
    [
      "p.then(ok, e => {})",
      1,
    ],
    [
      "p.then(ok, async () => {})",
      1,
    ],
    [
      "p.then(ok, () => undefined)",
      1,
    ],
    [
      "p.then(ok, () => null)",
      1,
    ],
    [
      "p.then(ok, function () {})",
      1,
    ],
    [
      "p.then((v) => { use(v); }, () => {})",
      1,
    ],
    [
      "p.then((v) => use(v, 1), () => {})",
      1,
    ],
    [
      "p.then(\n  (v) => use(v),\n  () => {},\n)",
      1,
    ],
    [
      'p.then(() => say("a, b"), () => {})',
      1,
    ],
    [
      "p.then(ok, () => {}).then(next, () => {})",
      2,
    ],
  ];
  for (const [source, count] of swallowing) {
    expect(countEmptyHandlers(source)).toBe(count);
  }
});

test("the empty handler check leaves handlers that act on the error alone", () => {
  const handled = [
    "p.catch(() => { /* the window is already gone */ })",
    "p.catch((e) => { log(e); })",
    "p.catch((e) => log(e))",
    "p.catch((e) => e)",
    "p.catch(() => fallback)",
    "p.catch(() => undefinedValue)",
    "p.catch(() => nullish())",
    "p.catch(() => ({}))",
    "p.catch(handle)",
    "p.then(() => {})",
    "p.finally(() => {})",
    "p.then(() => {}, (e) => report(e))",
    "p.then(ok)",
    "p.then(() => {})",
    "p.then(ok, handle)",
    "p.then(ok, () => { /* the window is already gone */ })",
    "p.then(ok, (e) => { log(e); })",
    "p.then(ok, (e) => e)",
    "p.then(ok, () => ({}))",
    "p.then(() => {}, () => fallback)",
    'p.then(a).on("x", () => {})',
    "p.then(a); other(b, () => {})",
    'p.then(() => say("x", () => {}))',
    "try { run(); } catch (e) { report(e); }",
    "try { run(); } catch { /* ignored: the file may not exist */ }",
    "const f = () => {};",
  ];
  for (const source of handled) {
    expect(countEmptyHandlers(source)).toBe(0);
  }
});
