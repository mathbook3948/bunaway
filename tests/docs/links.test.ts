import { expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

type LinkCase = {
  name: string;
  index?: string;
  files?: Record<string, string>;
  directories?: string[];
  outsideFile?: string;
  exitCode: number;
  output?: string;
};

const checker = resolve(
  import.meta.dir,
  "../../docs/site/scripts/check-links.mjs",
);
const cases: LinkCase[] = [
  {
    name: "accepts files and anchors in generated HTML",
    index:
      '<a href="/assets/readme.txt">file</a><a href="/guide/#topic">anchor</a>',
    files: {
      "assets/readme.txt": "content",
      "guide/index.html": '<h1 id="topic">Guide</h1>',
    },
    exitCode: 0,
    output: "2 links and anchors checked across 2 HTML pages",
  },
  {
    name: "rejects a directory without generated HTML",
    index: '<a href="/assets/empty/">directory</a>',
    directories: [
      "assets/empty",
    ],
    exitCode: 1,
    output: "missing /assets/empty/",
  },
  {
    name: "rejects an empty dist directory",
    exitCode: 1,
    output: "No HTML pages found in docs/site/dist.",
  },
  {
    name: "rejects an invalid URL",
    index: '<a href="http://[">invalid</a>',
    exitCode: 1,
    output: "invalid URL http://[",
  },
  {
    name: "rejects malformed percent encoding",
    index: '<a href="/bad%ZZ">invalid encoding</a>',
    exitCode: 1,
    output: "invalid URL encoding /bad%ZZ",
  },
  {
    name: "rejects a path escaping dist even when the file exists outside it",
    index: '<a href="/%2e%2e%2f%2e%2e%2f%2e%2e%2foutside.html">escape</a>',
    outsideFile: "outside.html",
    exitCode: 1,
    output: "missing /%2e%2e%2f%2e%2e%2f%2e%2e%2foutside.html",
  },
];

for (const scenario of cases) {
  test(scenario.name, async () => {
    const root = await mkdtemp(join(tmpdir(), "bunaway-doc-links-"));
    const scripts = resolve(root, "docs/site/scripts");
    const dist = resolve(root, "docs/site/dist");
    const script = resolve(scripts, "check-links.mjs");

    try {
      await mkdir(scripts, {
        recursive: true,
      });
      await mkdir(dist, {
        recursive: true,
      });
      await copyFile(checker, script);

      if (scenario.index !== undefined) {
        await writeFile(resolve(dist, "index.html"), scenario.index);
      }
      for (const [path, contents] of Object.entries(scenario.files ?? {})) {
        const destination = resolve(dist, path);
        await mkdir(dirname(destination), {
          recursive: true,
        });
        await writeFile(destination, contents);
      }
      for (const path of scenario.directories ?? []) {
        await mkdir(resolve(dist, path), {
          recursive: true,
        });
      }
      if (scenario.outsideFile) {
        await writeFile(resolve(root, scenario.outsideFile), "outside dist");
      }

      const result = Bun.spawnSync(
        [
          process.execPath,
          script,
        ],
        {
          cwd: root,
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const decoder = new TextDecoder();
      const output = `${decoder.decode(result.stdout)}\n${decoder.decode(result.stderr)}`;
      expect(result.exitCode).toBe(scenario.exitCode);
      if (scenario.output) {
        expect(output).toContain(scenario.output);
      }
    } finally {
      await rm(root, {
        recursive: true,
        force: true,
      });
    }
  });
}
