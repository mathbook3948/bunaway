import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { isRecord } from "@bunaway/protocol";

const plugins = resolve(import.meta.dir, "../../plugins");
const docs = resolve(
  import.meta.dir,
  "../../docs/site/src/content/docs/reference/plugins",
);
/** The page must name at least this many plugins, so a broken scan cannot pass by comparing none. */
const MIN_COMPARED_PLUGINS = 10;

interface PluginShape {
  /** Native plugin name, the prefix of every operation (`tray` in `tray.get`). */
  name: string;
  windows: ReadonlySet<string>;
  macos: ReadonlySet<string>;
  events: ReadonlySet<string>;
}

interface Mention {
  name: string;
  /** Whether a heading above the mention names macOS. */
  macosSection: boolean;
}

/**
 * Plugins whose operations are not documented in `reference/plugins/<plugin>.mdx`; each has one
 * page per operation under `reference/host`. The list only shrinks: once `<plugin>.mdx` exists the
 * entry is reported as stale and the plugin is compared like the others.
 */
const OPERATIONS_DOCUMENTED_ELSEWHERE: Record<string, string> = {
  log: "Each operation has its own page under reference/host.",
  storage: "Each operation has its own page under reference/host.",
  windows:
    "Window operations are documented under reference/host and the window guides.",
};
/**
 * Dotted names in a plugin page that are neither Windows operations nor events, with the reason
 * each is allowed. The list only shrinks: a name the page no longer mentions is reported as stale.
 */
const NAMED_NON_OPERATIONS: Record<string, string> = {
  "autostart.enableAutostart": "Public API name of autostart.enable.",
  "autostart.getAutostartStatus": "Public API name of autostart.getStatus.",
  "autostart.disableAutostart": "Public API name of autostart.disable.",
  "dialog.showCertificateTrustDialog":
    "Electron API that the page states is not provided.",
  "path.posix": "Name of the Node.js path namespace the page follows.",
  "path.win32": "Name of the Node.js path namespace the page follows.",
};

/** Read the registered operations of one plugin without running its native adapters. */
async function pluginShape(
  directory: string,
): Promise<PluginShape | undefined> {
  const loaded: unknown = await import(
    resolve(plugins, directory, "src/index.ts")
  ).catch(() => undefined);
  const api = isRecord(loaded) ? loaded.default : undefined;
  // The default export is the plugin's public API, a function or an object, with the registration
  // metadata attached as a non-enumerable `_definition`.
  const definition: unknown =
    typeof api === "function" || isRecord(api)
      ? Reflect.get(api, "_definition")
      : undefined;
  if (!isRecord(definition)) {
    return undefined;
  }
  const name = String(definition.name);
  const platforms = definition.nativePlatforms;
  const operationsOf = (platform: string): ReadonlySet<string> => {
    const target = isRecord(platforms) ? platforms[platform] : undefined;
    const operations = isRecord(target) ? target.operations : undefined;
    return new Set(
      Array.isArray(operations)
        ? operations.map((operation) => `${name}.${String(operation)}`)
        : [],
    );
  };
  return {
    name,
    windows: operationsOf("windows"),
    macos: operationsOf("macos"),
    // Event keys are already `<plugin>.<event>`.
    events: new Set(
      isRecord(definition.events) ? Object.keys(definition.events) : [],
    ),
  };
}

/**
 * Dotted `plugin.name` mentions in a page. Paths, config keys (`desktop.tray.icon`) and file names
 * (`tray.ico`, `windows-tray.test.ts`) are not mentions, and headings inside code fences are text.
 */
function mentions(text: string, plugin: string): Mention[] {
  const pattern = new RegExp(
    `(?<![\\w./-])${plugin.replaceAll("-", "\\-")}\\.([A-Za-z]\\w*)(?!\\.?[\\w-])`,
    "g",
  );
  const found: Mention[] = [];
  const headings: string[] = [];
  let fenced = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("```")) {
      fenced = !fenced;
    }
    const heading = fenced ? null : /^(#{2,6})\s+(.*)$/.exec(line);
    if (heading?.[1] !== undefined && heading[2] !== undefined) {
      // A heading closes every heading of its depth or deeper.
      headings.length = heading[1].length - 2;
      headings.push(heading[2]);
    }
    const macosSection = headings.some((title) => title.includes("macOS"));
    for (const match of line.matchAll(pattern)) {
      found.push({
        name: `${plugin}.${match[1]}`,
        macosSection,
      });
    }
  }
  return found;
}

/** Differences between one page and the plugin's Windows registration. */
function compare(shape: PluginShape, page: string) {
  const found = mentions(page, shape.name);
  const named = new Set(found.map((mention) => mention.name));
  const undocumented = [
    ...shape.windows,
  ].filter((operation) => !named.has(operation));
  const usedExceptions = new Set<string>();
  const unregistered: string[] = [];
  for (const mention of found) {
    const registered =
      shape.windows.has(mention.name) ||
      shape.events.has(mention.name) ||
      (mention.macosSection && shape.macos.has(mention.name));
    if (registered) {
      continue;
    }
    if (mention.name in NAMED_NON_OPERATIONS) {
      usedExceptions.add(mention.name);
    } else {
      unregistered.push(mention.name);
    }
  }
  return {
    undocumented,
    unregistered: [
      ...new Set(unregistered),
    ],
    usedExceptions,
  };
}

test("plugin pages name every Windows operation and no operation Windows lacks", async () => {
  const directories = readdirSync(plugins, {
    withFileTypes: true,
  })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  const undocumented: string[] = [];
  const unregistered: string[] = [];
  const staleOperationsExceptions: string[] = [];
  const usedExceptions = new Set<string>();
  let compared = 0;
  for (const directory of directories) {
    const shape = await pluginShape(directory);
    if (shape === undefined || shape.windows.size === 0) {
      continue;
    }
    const page = Bun.file(resolve(docs, `${directory}.mdx`));
    const hasPage = await page.exists();
    if (directory in OPERATIONS_DOCUMENTED_ELSEWHERE) {
      if (hasPage) {
        staleOperationsExceptions.push(directory);
      }
      continue;
    }
    if (!hasPage) {
      undocumented.push(`${directory}: no reference/plugins/${directory}.mdx`);
      continue;
    }
    compared++;
    const result = compare(shape, await page.text());
    undocumented.push(
      ...result.undocumented.map(
        (operation) => `${directory}: ${operation} is registered on Windows`,
      ),
    );
    unregistered.push(
      ...result.unregistered.map(
        (name) => `${directory}: ${name} is not a Windows operation or event`,
      ),
    );
    for (const name of result.usedExceptions) {
      usedExceptions.add(name);
    }
  }
  expect(compared).toBeGreaterThan(MIN_COMPARED_PLUGINS);
  // Document the operation in its plugin page, or remove it from the Windows adapter.
  expect(undocumented).toEqual([]);
  // Correct the page to the operations the Windows adapter registers.
  expect(unregistered).toEqual([]);
  // A page that now exists, or a name the page no longer mentions, leaves the exception lists.
  expect(staleOperationsExceptions).toEqual([]);
  expect(
    Object.keys(NAMED_NON_OPERATIONS).filter(
      (name) => !usedExceptions.has(name),
    ),
  ).toEqual([]);
});

test("the mention scan reads dotted names but not paths, config keys or file names", () => {
  const text = [
    "## Windows",
    "`tray.get` and tray.setTooltip({ tooltip }).",
    "`desktop.tray.icon` and resources/tray.ico and tests/windows-tray.test.ts.",
    "## macOS 메뉴 막대",
    "`tray.setTitle`",
    "```ts",
    "// ## not a heading",
    "await tray.waitForEvent(null);",
    "```",
  ].join("\n");
  expect(
    mentions(text, "tray").map(({ name, macosSection }) => [
      name,
      macosSection,
    ]),
  ).toEqual([
    [
      "tray.get",
      false,
    ],
    [
      "tray.setTooltip",
      false,
    ],
    [
      "tray.setTitle",
      true,
    ],
    [
      "tray.waitForEvent",
      true,
    ],
  ]);
});

test("compare names a Windows operation the page omits and a name the adapter lacks", () => {
  const shape: PluginShape = {
    name: "tray",
    windows: new Set([
      "tray.get",
      "tray.focus",
    ]),
    macos: new Set([
      "tray.setTitle",
    ]),
    events: new Set([
      "tray.input",
    ]),
  };
  const result = compare(
    shape,
    [
      "## Windows",
      "`tray.get`, `tray.input` and `tray.setTitle`, then `tray.remove`.",
      "## macOS",
      "`tray.setTitle`",
    ].join("\n"),
  );
  expect(result.undocumented).toEqual([
    "tray.focus",
  ]);
  // The macOS-only operation is accepted in the macOS section only.
  expect(result.unregistered).toEqual([
    "tray.setTitle",
    "tray.remove",
  ]);
});
