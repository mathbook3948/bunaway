import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { runWindowsApp } from "../../native/windows/bun/entry.ts";
import { closeWindowsApp } from "../../packages/cli/src/windows-dev-launch.ts";
import type { HostContext, Policy } from "../../packages/protocol/src/index.ts";
import { storagePlugin } from "../../plugins/storage/src/index.ts";
import pin from "../../runtime/build-manifests/windows-x64.json";
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
  : resolve(
      buildRoot,
      `windows-storage-metadata-${process.pid}-${crypto.randomUUID()}`,
    );
const outputRelativeToBuild = relative(buildRoot, output);
// The parent recursively removes this unique output directory after the host exits.
assert(
  outputRelativeToBuild &&
    outputRelativeToBuild !== ".." &&
    !outputRelativeToBuild.startsWith(`..${sep}`) &&
    !isAbsolute(outputRelativeToBuild),
  "Storage metadata test output must be inside the repository build directory.",
);
const dataRoot = resolve(output, "data-root");
const assets = resolve(output, "assets");
const reportPath = resolve(output, "report.json");
const unicodeDirectory = "notes/한글 folder";
const unicodeFile = `${unicodeDirectory}/현재 draft.txt`;
const unicodeText = "공백과 한글 경로 🙂";
const policy: Policy = {
  version: 1,
  views: [
    {
      id: "main",
      origins: [
        "https://app.bunaway.local",
      ],
      commands: [
        "plugin.storage.exists",
        "plugin.storage.stat",
        "test.report",
        "test.report-confirmed",
      ],
      events: [],
      host: {
        permissions: [
          {
            identifier: "storage:read-metadata",
            allow: [
              {
                scope: "appData",
                pathPrefix: "notes",
              },
            ],
          },
        ],
      },
    },
  ],
  backend: {
    permissions: [
      {
        identifier: "storage:read-metadata",
        allow: [
          {
            scope: "appData",
            pathPrefix: "",
          },
        ],
      },
    ],
  },
};

if (!process.argv.includes("--child")) {
  // Seed Unicode paths and build the browser client before starting the native host.
  try {
    await mkdir(resolve(assets, "web"), {
      recursive: true,
    });
    await mkdir(resolve(dataRoot, "data", unicodeDirectory), {
      recursive: true,
    });
    await writeFile(
      resolve(dataRoot, "data", unicodeFile),
      unicodeText,
      "utf8",
    );
    const built = await Bun.build({
      entrypoints: [
        resolve(import.meta.dir, "windows-bun/storage-metadata.js"),
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
      "windows-storage-metadata",
      resolve(output, "driver"),
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
            if (event.event === "storage-metadata-report-confirmed") {
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
        report.error ?? "Metadata browser test failed.",
      );
      assert.equal(report.existsFile, true);
      assert.equal(report.existsDirectory, true);
      assert.equal(report.existsMissing, false);
      assert.equal(report.file.kind, "file");
      assert.equal(report.file.sizeBytes, Buffer.byteLength(unicodeText));
      assert.equal(report.directory.kind, "directory");
      assert.equal(report.directory.sizeBytes, null);
      assert.equal(report.missing, null);
      assert.deepEqual(report.denied, [
        "PERMISSION_DENIED",
        "PERMISSION_DENIED",
      ]);
      console.log(
        "PASS Windows WebView2 storage metadata: API, I/O Worker, FFI, Unicode paths, missing targets and scoped permissions",
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
      storagePlugin,
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
              event: "storage-metadata-report-confirmed",
            }),
          );
          return null;
        },
      },
    },
  } as const;
  await runWindowsApp(app, {
    runtime: {
      id: "windows-storage-metadata",
      generation: crypto.randomUUID(),
    },
    backendContext: `backend-${crypto.randomUUID()}` as HostContext,
    policy,
    windows: [
      {
        view: "main",
        title: "Storage metadata regression",
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
      "native/windows/bun/vendor/sdk/build/native/x64/WebView2Loader.dll",
    ),
  });
}
