import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import path from "@bunaway/plugin-path";
import type { HostContext, Policy } from "@bunaway/protocol";
import { closeWindowsApp } from "#cli/windows-dev-launch";
import { runWindowsApp } from "#native/windows/bun/entry";
import pin from "../../runtime/build-manifests/windows-x64.json";
import { testAppMetadata } from "../fixtures/app-info.ts";
import { bundleNativeWorker } from "../fixtures/native-worker.ts";

assert.equal(process.platform, "win32");
assert.equal(Bun.version, pin.bun.version);
assert.equal(Bun.revision, pin.bun.sourceRevision);

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  return index < 0 ? "" : (process.argv[index + 1] ?? "");
}

const childMode = process.argv.includes("--child");
const repoRoot = childMode
  ? argument("--repo")
  : resolve(import.meta.dir, "../..");
assert(repoRoot, "Missing repository root.");
const buildRoot = resolve(repoRoot, "build");
const output = childMode
  ? resolve(argument("--output"))
  : resolve(buildRoot, `windows-path-${process.pid}-${crypto.randomUUID()}`);
const outputRelativeToBuild = relative(buildRoot, output);
// The parent recursively removes this unique output directory after the host exits.
assert(
  outputRelativeToBuild &&
    outputRelativeToBuild !== ".." &&
    !outputRelativeToBuild.startsWith(`..${sep}`) &&
    !isAbsolute(outputRelativeToBuild),
  "Path test output must be inside the repository build directory.",
);
const dataRoot = resolve(output, "data-root");
const assets = resolve(output, "assets");
const reportPath = resolve(output, "report.json");
const permissions = [
  "path.getDirectory",
  "path.getAppDirectory",
  "path.join",
  "path.resolve",
  "path.normalize",
  "path.basename",
  "path.extname",
  "path.isAbsolute",
];
const policy: Policy = {
  version: 1,
  views: [
    {
      id: "main",
      origins: [
        "https://app.bunaway.local",
      ],
      commands: [
        ...permissions.map((name) => `plugin.${name}`),
        "plugin.path.dirname",
        "test.report",
        "test.report-confirmed",
      ],
      events: [],
      host: {
        permissions,
      },
    },
  ],
  backend: {
    permissions,
  },
};
if (!process.argv.includes("--child")) {
  // Build the browser client before starting the native host.
  try {
    await mkdir(resolve(assets, "web"), {
      recursive: true,
    });
    const built = await Bun.build({
      entrypoints: [
        resolve(import.meta.dir, "windows-bun/path.js"),
      ],
      target: "browser",
    });
    assert(built.success && built.outputs[0]);
    await writeFile(
      resolve(assets, "web/app.js"),
      new Uint8Array(await built.outputs[0].arrayBuffer()),
    );
    await writeFile(
      resolve(assets, "web/index.html"),
      '<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\'"><script type="module" src="app.js"></script>',
    );

    const childEntry = await bundleNativeWorker(
      "windows-path",
      assets,
      import.meta.path,
    );
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        fileURLToPath(childEntry),
        "--child",
        "--repo",
        repoRoot,
        "--output",
        output,
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    let confirmed = false;
    let closedWindows = 0;
    let pending = "";
    const decoder = new TextDecoder();
    const stdout = child.stdout.pipeTo(
      new WritableStream({
        async write(chunk) {
          pending += decoder.decode(chunk, {
            stream: true,
          });
          while (pending.includes("\n")) {
            const end = pending.indexOf("\n");
            const line = pending.slice(0, end);
            pending = pending.slice(end + 1);
            if (!line) {
              continue;
            }
            const event = JSON.parse(line);
            if (event.event === "path-report-confirmed") {
              // The browser sends this signal only after its report command succeeds.
              confirmed = true;
              closedWindows = await closeWindowsApp(child.pid);
            }
          }
        },
      }),
    );
    const stderr = new Response(child.stderr).text();
    const timeout = setTimeout(() => child.kill(), 60000);
    try {
      const [code, , errors] = await Promise.all([
        child.exited,
        stdout,
        stderr,
      ]);
      clearTimeout(timeout);
      assert.equal(code, 0, errors);
      assert(
        confirmed,
        "Browser did not confirm receipt of the report result.",
      );
      assert.equal(closedWindows, 1, "Expected to close the test app window.");
      const report = JSON.parse(await readFile(reportPath, "utf8"));
      assert.equal(
        report.pass,
        true,
        report.error ?? "Path browser test failed.",
      );
      assert.equal(report.directories, 7);
      // The host passes its app id and dataRoot, so logs sits under the host-owned data root.
      assert.equal(report.logs, resolve(dataRoot, "logs"));
      assert.equal(report.lexical, true);
      assert.equal(report.denied, true);
      console.log(
        "PASS Windows WebView2 paths: public SDK, current-user shell folders, Windows lexical helpers, I/O Worker and permission denial",
      );
    } finally {
      clearTimeout(timeout);
      if (child.exitCode === null) {
        child.kill();
      }
      await child.exited;
    }
  } finally {
    // The child is awaited above before its isolated output tree is removed.
    await rm(output, {
      recursive: true,
      force: true,
    });
  }
} else {
  const app = {
    events: {},
    plugins: [
      path._definition,
    ],
    commands: {
      "test.report": {
        input: {},
        output: {
          const: null,
        },
        async run(report: unknown) {
          await writeFile(reportPath, JSON.stringify(report));
          return null;
        },
      },
      "test.report-confirmed": {
        input: {
          const: true,
        },
        output: {
          const: null,
        },
        async run() {
          console.log(
            JSON.stringify({
              event: "path-report-confirmed",
            }),
          );
          return null;
        },
      },
    },
  } as const;
  await runWindowsApp(app, {
    appMetadata: testAppMetadata,
    app: {
      id: "windows-path",
      launch: {
        mode: "development",
        executablePath: process.execPath,
        args: [],
      },
    },
    runtime: {
      id: "windows-path",
      generation: crypto.randomUUID(),
    },
    backendContext: `backend-${crypto.randomUUID()}` as HostContext,
    policy,
    windows: [
      {
        view: "main",
        title: "Windows path regression",
        home: "https://app.bunaway.local/index.html",
        window: {
          width: 640,
          height: 480,
        },
      },
    ],
    assets,
    dataRoot,
    loader: resolve(
      repoRoot,
      "build/cache/webview2/sdk/build/native/x64/WebView2Loader.dll",
    ),
  });
}
