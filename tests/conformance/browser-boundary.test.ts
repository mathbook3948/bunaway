import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { trayIco } from "../fixtures/tray-icon.ts";

const repository = resolve(import.meta.dir, "../..");
/** Twenty plugin bundles plus the client and the ICO parser, each built and loaded once. */
const SUITE_TIMEOUT_MS = 120_000;
/** Loading one bundle is immediate; a longer wait means the child hung at module evaluation. */
const LOAD_TIMEOUT_MS = 10_000;
/**
 * A WebView has none of these, and Bun cannot delete them from `globalThis`. Replacing every
 * bare reference at bundle time reproduces a WebView load: `Buffer.from` at module scope throws,
 * and `typeof Buffer` guards see "undefined" exactly as in a browser.
 */
const ABSENT_IN_WEBVIEW = {
  Buffer: "undefined",
  Bun: "undefined",
  process: "undefined",
};
/**
 * `define` rewrites bare identifiers only, so these spellings would still reach the Bun globals
 * in the child while failing in a WebView. The bundle text must not contain them.
 */
const GLOBAL_ESCAPES = [
  "globalThis.Buffer",
  "globalThis.Bun",
  "globalThis.process",
];

type FrameworkRelease = {
  plugins: Record<string, string>;
};

/**
 * A package a WebView bundle can import, plus the statements the child runs after loading it.
 * Module evaluation alone proves little once every top-level `Buffer` use is gone, so shared
 * code that parses input in the WebView is called with real data.
 */
type BrowserPackage = {
  name: string;
  probe?: string;
};

/** The client, the neutral entry of each plugin, and the shared ICO parser with a sample ICO. */
async function browserPackages(): Promise<BrowserPackage[]> {
  const release = (await Bun.file(
    resolve(repository, "framework.json"),
  ).json()) as FrameworkRelease;
  const ico = trayIco().toString("base64");
  return [
    {
      name: "@bunaway/client",
    },
    {
      name: "@bunaway/plugin-api/native",
      probe: `if (!loaded.parseNativeIco(${JSON.stringify(ico)})) { throw new Error("parseNativeIco rejected a valid ICO"); }`,
    },
    ...Object.values(release.plugins).map((name) => ({
      name,
    })),
  ];
}

/** Why the child failed: its first error line, or the signal when the deadline killed it. */
function loadFailure(load: ReturnType<typeof Bun.spawnSync>): string {
  if (load.exitCode === null) {
    return `killed by ${load.signalCode ?? "timeout"} after ${LOAD_TIMEOUT_MS} ms`;
  }
  const lines = (load.stderr?.toString() ?? "").trim().split("\n");
  const error = Math.max(
    lines.findIndex((line) => /Error/.test(line)),
    0,
  );
  return lines.slice(error, error + 2).join(" ");
}

test(
  "every plugin, the client and the ICO parser work in a bundle without Buffer, Bun or process",
  async () => {
    // Entries must resolve workspace packages, so they live under the repository, not tmpdir.
    await mkdir(resolve(repository, "build"), {
      recursive: true,
    });
    const directory = await mkdtemp(
      resolve(repository, "build/browser-boundary-"),
    );
    const failures: string[] = [];
    try {
      for (const { name, probe } of await browserPackages()) {
        const base = resolve(directory, name.replaceAll("/", "-"));
        await Bun.write(
          `${base}.ts`,
          `export * from ${JSON.stringify(name)};\n`,
        );
        const build = await Bun.build({
          entrypoints: [
            `${base}.ts`,
          ],
          target: "browser",
          define: ABSENT_IN_WEBVIEW,
        });
        const output = build.outputs[0];
        if (!build.success || !output) {
          failures.push(`${name}: ${build.logs.map(String).join("; ")}`);
          continue;
        }
        const source = await output.text();
        for (const spelling of GLOBAL_ESCAPES) {
          if (source.includes(spelling)) {
            failures.push(`${name}: bundle references ${spelling}`);
          }
        }
        await Bun.write(`${base}.js`, source);
        const load = Bun.spawnSync(
          [
            process.execPath,
            "-e",
            `const loaded = await import(${JSON.stringify(`${base}.js`)}); ${probe ?? ""}`,
          ],
          {
            cwd: directory,
            stdout: "pipe",
            stderr: "pipe",
            timeout: LOAD_TIMEOUT_MS,
          },
        );
        if (load.exitCode !== 0) {
          failures.push(`${name}: ${loadFailure(load)}`);
        }
      }
    } finally {
      await rm(directory, {
        recursive: true,
        force: true,
      });
    }
    expect(failures).toEqual([]);
  },
  SUITE_TIMEOUT_MS,
);
