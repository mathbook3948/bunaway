import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";

const repository = resolve(import.meta.dir, "../..");
/** Twenty plugin bundles plus the client, each built once and loaded in a child process. */
const SUITE_TIMEOUT_MS = 120_000;
/** Loading one bundle is immediate; a longer wait means the child hung at module evaluation. */
const LOAD_TIMEOUT_MS = 10_000;
/**
 * A WebView has none of these, and Bun cannot delete them from `globalThis`. Replacing every
 * reference at bundle time reproduces a WebView load: `Buffer.from` at module scope throws,
 * and `typeof Buffer` guards see "undefined" exactly as in a browser.
 */
const ABSENT_IN_WEBVIEW = {
  Buffer: "undefined",
  Bun: "undefined",
  process: "undefined",
};

type FrameworkRelease = {
  plugins: Record<string, string>;
};

/** Every package a WebView bundle can import: the client and the neutral entry of each plugin. */
async function browserPackages(): Promise<string[]> {
  const release = (await Bun.file(
    resolve(repository, "framework.json"),
  ).json()) as FrameworkRelease;
  return [
    "@bunaway/client",
    ...Object.values(release.plugins),
  ];
}

test(
  "every plugin and the client load in a bundle without Buffer, Bun or process",
  async () => {
    const directory = await mkdtemp(
      resolve(repository, "build/browser-boundary-"),
    );
    const failures: string[] = [];
    try {
      for (const name of await browserPackages()) {
        const entry = resolve(directory, `${name.replace("/", "-")}.ts`);
        await Bun.write(entry, `export * from ${JSON.stringify(name)};\n`);
        const build = await Bun.build({
          entrypoints: [
            entry,
          ],
          target: "browser",
          define: ABSENT_IN_WEBVIEW,
        });
        const output = build.outputs[0];
        if (!build.success || !output) {
          failures.push(`${name}: ${build.logs.map(String).join("; ")}`);
          continue;
        }
        const bundle = resolve(directory, `${name.replace("/", "-")}.js`);
        await Bun.write(bundle, output);
        const load = Bun.spawnSync(
          [
            process.execPath,
            "-e",
            `await import(${JSON.stringify(bundle)});`,
          ],
          {
            cwd: directory,
            stdout: "pipe",
            stderr: "pipe",
            timeout: LOAD_TIMEOUT_MS,
          },
        );
        if (load.exitCode !== 0) {
          // Bun prints the failing module-scope statement, then the error with its location.
          const lines = load.stderr.toString().trim().split("\n");
          const error = lines.findIndex((line) => /Error/.test(line));
          failures.push(
            `${name}: ${lines.slice(Math.max(error, 0), Math.max(error, 0) + 2).join(" ")}`,
          );
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
