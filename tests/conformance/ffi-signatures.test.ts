import { expect, test } from "bun:test";
import { resolve } from "node:path";

const repository = resolve(import.meta.dir, "../..");
/** Where FFI symbol tables live: hosts, plugin platform code and the shared SDK bindings. */
const FFI_SOURCE_GLOBS = [
  "native/**/*.ts",
  "plugins/*/src/**/*.ts",
  "packages/plugin-sdk/src/**/*.ts",
];
/**
 * Symbols that are declared with different signatures today. The list only shrinks: remove a name
 * once every declaration agrees (or imports the shared table), and never add one. A new symbol
 * declared two ways fails below with every location. The original twelve (clipboard, window and
 * global memory functions on Windows; the loader and Objective-C runtime on macOS) now come from
 * the shared tables.
 */
const KNOWN_CONFLICTS: string[] = [];
/** Variadic by design: every call site declares the argument shape it needs. */
const VARIADIC_SYMBOLS = new Set([
  "objc_msgSend",
  "objc_msgSend_stret",
  "objc_msgSend_fpret",
]);

type Declaration = {
  file: string;
  line: number;
  shape: string;
};

/**
 * Every `symbol: { args: [...], returns: "..." }` entry in the FFI sources, read line by line. The
 * repository's Biome formatting (`expand: always`) puts each entry, each argument and each
 * `returns` on its own line, so the scan keys on indentation instead of parsing TypeScript; the
 * installed `typescript` package is the native preview without a JavaScript AST API. An entry that
 * carries `ptr:` is a `linkSymbols` alias for a local address, not a library symbol.
 */
/** The lines of one entry body, from the line after `name: {` to the `}` on the same indentation. */
function entryBody(
  lines: readonly string[],
  opening: number,
  indent: string,
): string[] {
  const body: string[] = [];
  for (let cursor = opening + 1; cursor < lines.length; cursor++) {
    const line = lines[cursor] ?? "";
    if (line.startsWith(`${indent}}`)) {
      break;
    }
    body.push(line.trim());
  }
  return body;
}

/** The `(args) -> returns` shape of one entry body, or undefined for an alias or a non-table object. */
function shapeOf(body: readonly string[]): string | undefined {
  let args: string[] | undefined;
  let returns: string | undefined;
  let inArgs = false;
  const unquote = (text: string) => text.replace(/^"|",?$/g, "");
  for (const line of body) {
    if (inArgs) {
      inArgs = !line.startsWith("]");
      if (inArgs) {
        args?.push(unquote(line));
      }
    } else if (line === "args: [],") {
      args = [];
    } else if (line === "args: [") {
      args = [];
      inArgs = true;
    } else if (line.startsWith("returns: ")) {
      returns = unquote(line.slice("returns: ".length));
    } else if (line.startsWith("ptr: ")) {
      return undefined;
    }
  }
  return args === undefined || returns === undefined
    ? undefined
    : `(${args.join(", ")}) -> ${returns}`;
}

async function declarations(): Promise<Map<string, Declaration[]>> {
  const found = new Map<string, Declaration[]>();
  const entryStart = /^(\s*)(?:"([^"]+)"|([A-Za-z_$][\w$]*)): \{$/;
  for (const pattern of FFI_SOURCE_GLOBS) {
    for await (const file of new Bun.Glob(pattern).scan({
      cwd: repository,
    })) {
      if (/(^|\/)(node_modules|dist)\//.test(file)) {
        continue;
      }
      const lines = (await Bun.file(resolve(repository, file)).text()).split(
        "\n",
      );
      for (let index = 0; index < lines.length; index++) {
        const opening = entryStart.exec(lines[index] ?? "");
        if (!opening) {
          continue;
        }
        const shape = shapeOf(entryBody(lines, index, opening[1] ?? ""));
        if (!shape) {
          continue;
        }
        const name = opening[2] ?? opening[3] ?? "";
        const list = found.get(name) ?? [];
        list.push({
          file,
          line: index + 1,
          shape,
        });
        found.set(name, list);
      }
    }
  }
  return found;
}

test("a library symbol keeps one FFI signature across the repository, and the known conflicts only shrink", async () => {
  const found = await declarations();
  expect(found.size).toBeGreaterThan(200);
  const conflicting = new Map<string, Declaration[]>();
  for (const [name, list] of found) {
    if (VARIADIC_SYMBOLS.has(name)) {
      continue;
    }
    if (new Set(list.map((declaration) => declaration.shape)).size > 1) {
      conflicting.set(name, list);
    }
  }
  const unexpected = [
    ...conflicting,
  ]
    .filter(([name]) => !KNOWN_CONFLICTS.includes(name))
    .map(
      ([name, list]) =>
        `${name}:\n${list.map((d) => `  ${d.file}:${d.line} ${d.shape}`).join("\n")}`,
    );
  // Declare the symbol once in packages/plugin-sdk/src/win32.ts or darwin.ts and pick it from
  // there, instead of redeclaring it with another handle or BOOL convention.
  expect(unexpected).toEqual([]);
  const resolved = KNOWN_CONFLICTS.filter((name) => !conflicting.has(name));
  // A resolved conflict leaves the list so the ratchet keeps its new ground.
  expect(resolved).toEqual([]);
});
