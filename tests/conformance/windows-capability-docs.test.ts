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
 * Plugins with no `reference/plugins/<plugin>.mdx`; their operations are documented under
 * `reference/host` instead (`log-write.mdx`, `storage-*.mdx`, `windows.mdx`), which this test does
 * not compare. The list only shrinks: once `<plugin>.mdx` exists the entry is reported as stale
 * and the plugin is compared like the others. `MAX_DOCUMENTED_ELSEWHERE` stops it from growing.
 */
const OPERATIONS_DOCUMENTED_ELSEWHERE: Record<string, string> = {
  log: "Documented on a reference/host page, not a plugin page.",
  storage: "Documented on reference/host pages, not a plugin page.",
  windows: "Documented on the reference/host windows page, not a plugin page.",
};
const MAX_DOCUMENTED_ELSEWHERE = 3;
/**
 * Plugins that declare no native platform, so there is nothing to register or import. The source
 * must still declare `platforms: {}`; a plugin that gains operations fails as stale. Any other
 * plugin without a readable Windows operation list fails the test. The list never grows.
 */
const DECLARES_NO_PLATFORMS: Record<string, string> = {
  "window-state":
    "Declares no native operations; every call goes through the window and store plugins.",
};
const MAX_DECLARES_NO_PLATFORMS = 1;
const NO_PLATFORMS_DECLARATION = /\bplatforms:\s*\{\s*\}/;
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
const MAX_NAMED_NON_OPERATIONS = 6;
/** Extensions of file names such as `tray.ico`, which are not operation names. */
const FILE_EXTENSIONS = new Set([
  "ico",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "svg",
  "ts",
  "js",
  "json",
  "env",
  "md",
  "mdx",
  "exe",
  "dll",
  "plist",
  "log",
  "txt",
]);

/**
 * Read the registered operations of one plugin. Importing evaluates the plugin's module graph but
 * never calls an adapter's `create` or `initialize`. A string result is why the plugin could not be read.
 */
async function pluginShape(directory: string): Promise<PluginShape | string> {
  let importFailure = "";
  const loaded: unknown = await import(
    resolve(plugins, directory, "src/index.ts")
  ).catch((error: unknown) => {
    importFailure = `import failed: ${String(error).split("\n")[0]}`;
  });
  if (importFailure !== "") {
    return importFailure;
  }
  const api = isRecord(loaded) ? loaded.default : undefined;
  // The default export is the plugin's public API, a function or an object, with the registration
  // metadata attached as a non-enumerable `_definition`.
  const definition: unknown =
    typeof api === "function" || isRecord(api)
      ? Reflect.get(api, "_definition")
      : undefined;
  if (!isRecord(definition)) {
    return "default export has no registration metadata";
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
function mentions(
  text: string,
  plugin: string,
  known: ReadonlySet<string> = new Set(),
): Mention[] {
  const pattern = new RegExp(
    `(?<![\\w./-])${plugin.replaceAll("-", "\\-")}\\.([A-Za-z]\\w*)(?!\\.?[\\w-])`,
    "g",
  );
  const found: Mention[] = [];
  const headings: string[] = [];
  // The marker of the open code fence; only a marker of the same character, at least as long, closes it.
  let fence = "";
  for (const line of text.split("\n")) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker !== undefined) {
      if (fence === "") {
        fence = marker;
      } else if (marker[0] === fence[0] && marker.length >= fence.length) {
        fence = "";
      }
    }
    const heading = fence !== "" ? null : /^(#{2,6})\s+(.*)$/.exec(line);
    if (heading?.[1] !== undefined && heading[2] !== undefined) {
      // A heading closes every heading of its depth or deeper.
      headings.length = heading[1].length - 2;
      headings.push(heading[2]);
    }
    const macosSection = headings.some((title) => title.startsWith("macOS"));
    for (const match of line.matchAll(pattern)) {
      const name = `${plugin}.${match[1]}`;
      if (FILE_EXTENSIONS.has(match[1] ?? "") && !known.has(name)) {
        continue;
      }
      found.push({
        name,
        macosSection,
      });
    }
  }
  return found;
}

/** Differences between one page and the plugin's Windows registration. */
function compare(shape: PluginShape, page: string) {
  const found = mentions(
    page,
    shape.name,
    new Set([
      ...shape.windows,
      ...shape.macos,
      ...shape.events,
    ]),
  );
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
  const unreadable: string[] = [];
  const undocumented: string[] = [];
  const unregistered: string[] = [];
  const staleOperationsExceptions: string[] = [];
  const usedExceptions = new Set<string>();
  let compared = 0;
  for (const directory of directories) {
    if (directory in DECLARES_NO_PLATFORMS) {
      const source = await Bun.file(
        resolve(plugins, directory, "src/index.ts"),
      ).text();
      if (!NO_PLATFORMS_DECLARATION.test(source)) {
        unreadable.push(`${directory}: no longer declares \`platforms: {}\``);
      }
      continue;
    }
    const shape = await pluginShape(directory);
    const readable = typeof shape === "string" ? undefined : shape;
    if (readable === undefined || readable.windows.size === 0) {
      unreadable.push(
        `${directory}: ${readable === undefined ? shape : "registers no Windows operations"}`,
      );
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
    const result = compare(readable, await page.text());
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
  // A plugin that cannot be read is a failure, not a silent skip: fix the import or list it in
  // DECLARES_NO_PLATFORMS if it truly declares none.
  expect(unreadable).toEqual([]);
  expect(
    Object.keys(OPERATIONS_DOCUMENTED_ELSEWHERE).length,
  ).toBeLessThanOrEqual(MAX_DOCUMENTED_ELSEWHERE);
  expect(Object.keys(DECLARES_NO_PLATFORMS).length).toBeLessThanOrEqual(
    MAX_DECLARES_NO_PLATFORMS,
  );
  expect(Object.keys(NAMED_NON_OPERATIONS).length).toBeLessThanOrEqual(
    MAX_NAMED_NON_OPERATIONS,
  );
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
    "`desktop.tray.icon` and resources/tray.ico and tests/windows-tray.test.ts and tray.ico.",
    "## macOS 메뉴 막대",
    "`tray.setTitle`",
    "  ```ts",
    "  // ## not a heading",
    "  await tray.waitForEvent(null);",
    "  ```",
    "~~~",
    "## also not a heading",
    "~~~",
    "## Windows와 macOS 차이",
    "tray.after",
    "````md",
    "```",
    "## inside four backticks",
    "````",
    "tray.last",
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
    [
      "tray.after",
      false,
    ],
    [
      "tray.last",
      false,
    ],
  ]);
});

test("a registered operation named like a file extension is still a mention", () => {
  const text = "`tray.log` writes, tray.png is a file.";
  expect(
    mentions(
      text,
      "tray",
      new Set([
        "tray.log",
      ]),
    ).map(({ name }) => name),
  ).toEqual([
    "tray.log",
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
