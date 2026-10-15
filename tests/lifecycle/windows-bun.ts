import { dlopen, ptr } from "bun:ffi";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AppDefinition } from "@bunaway/core";
import log from "@bunaway/plugin-log";
import type { HostContext, Policy } from "@bunaway/protocol";
import { closeWindowsApp } from "#cli/windows-dev-launch";
import { runWindowsApp } from "#native/windows/bun/entry";
import pin from "../../runtime/build-manifests/windows-x64.json";
import { contracts } from "../fixtures/host-plugins.ts";
import { bundleNativeWorker } from "../fixtures/native-worker.ts";

const MODAL_OBSERVATION_MS = 700;

assert.equal(Bun.version, pin.bun.version);
assert.equal(Bun.revision, pin.bun.sourceRevision);
const repoRoot = process.argv.includes("--repo")
  ? (process.argv[process.argv.indexOf("--repo") + 1] ?? "")
  : resolve(import.meta.dir, "../..");
const output = resolve(repoRoot, "build/windows-bun-core");
const assets = resolve(output, "assets");
const dataRoot = resolve(output, `data-${process.pid}`);
const modal = process.argv.includes("--modal");
const earlyClose = process.argv.includes("--early-close");
const creationFailure = process.argv.includes("--creation-failure");
const policy: Policy = {
  version: 1,
  views: [
    {
      id: "main",
      origins: [
        "https://app.bunaway.local",
      ],
      commands: [
        "test.echo",
        "test.emit",
        "test.hold",
        "test.report",
      ],
      events: [
        "test.changed",
      ],
      host: {
        permissions: [
          "log.write",
        ],
      },
    },
  ],
  backend: {
    permissions: [
      "log.write",
    ],
  },
};
if (!process.argv.includes("--child")) {
  await mkdir(resolve(assets, "web"), {
    recursive: true,
  });
  const built = await Bun.build({
    entrypoints: [
      resolve(import.meta.dir, "windows-bun/web.js"),
    ],
    target: "browser",
  });
  assert(built.success);
  assert(built.outputs[0]);
  await writeFile(
    resolve(assets, "web/app.js"),
    new Uint8Array(await built.outputs[0].arrayBuffer()),
  );
  await writeFile(
    resolve(assets, "web/index.html"),
    '<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\'"><output>waiting</output><script type="module" src="app.js"></script>',
  );
  const childEntry = await bundleNativeWorker(
    "windows-bun",
    assets,
    import.meta.path,
  );
  // Keep FFI calls in the parent driver while the packaged host runs in its own process.
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      fileURLToPath(childEntry),
      "--child",
      "--repo",
      repoRoot,
      ...process.argv.slice(2),
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const driver = dlopen("user32.dll", {
    GetWindowThreadProcessId: {
      args: [
        "u64",
        "ptr",
      ],
      returns: "u32",
    },
    GetGUIThreadInfo: {
      args: [
        "u32",
        "ptr",
      ],
      returns: "i32",
    },
    PostMessageW: {
      args: [
        "u64",
        "u32",
        "u64",
        "i64",
      ],
      returns: "i32",
    },
  });
  let hwnd = 0n;
  const started = performance.now();
  let requested = false;
  let inModal = false;
  let entered = false;
  let left = false;
  let modalExitTimer: ReturnType<typeof setTimeout> | undefined;
  let latest = {
    ticks: 0,
    promises: 0,
    network: 0,
  };
  let baseline = latest;
  let during = latest;
  let text = "";
  let pending = "";
  // Query the owning thread without posting input or altering the deadline.
  const diagnose = (phase: string) => {
    const owner = Buffer.alloc(4);
    const thread = driver.symbols.GetWindowThreadProcessId(hwnd, ptr(owner));
    // GUITHREADINFO is 72 bytes in the pinned Windows x64 host.
    const info = Buffer.alloc(72);
    info.writeUInt32LE(info.length);
    const available =
      thread !== 0 && driver.symbols.GetGUIThreadInfo(thread, ptr(info)) !== 0;
    console.error(
      JSON.stringify({
        fixture: "windows-bun",
        phase,
        elapsedMs: performance.now() - started,
        childPid: child.pid,
        windowPid: owner.readUInt32LE(),
        thread,
        hwnd: hwnd.toString(),
        requested,
        entered,
        left,
        latest,
        gui: available
          ? {
              flags: info.readUInt32LE(4),
              active: info.readBigUInt64LE(8).toString(),
              focus: info.readBigUInt64LE(16).toString(),
              capture: info.readBigUInt64LE(24).toString(),
              moveSize: info.readBigUInt64LE(40).toString(),
            }
          : null,
      }),
    );
  };
  const decoder = new TextDecoder();
  const stdout = child.stdout.pipeTo(
    new WritableStream({
      async write(chunk) {
        const value = decoder.decode(chunk, {
          stream: true,
        });
        text += value;
        pending += value;
        while (pending.includes("\n")) {
          const end = pending.indexOf("\n");
          const line = pending.slice(0, end);
          pending = pending.slice(end + 1);
          if (!line) {
            continue;
          }
          const event = JSON.parse(line);
          if (event.event === "window-created") {
            hwnd = BigInt(event.hwnd);
            if (earlyClose) {
              assert.equal(await closeWindowsApp(child.pid), 1);
            }
          }
          if (
            modal &&
            !requested &&
            event.event === "web-message" &&
            event.kind === "invoke"
          ) {
            requested = true;
            // Request the native move loop. Its actual entry starts the observation interval.
            assert(driver.symbols.PostMessageW(hwnd, 0x112, 0xf010n, 0n));
            diagnose("move-requested");
          }
          if (event.event === "modal-enter") {
            entered = true;
            inModal = true;
            baseline = latest;
            // A cancel queued before Win32 enters can end the loop before any backend sample.
            modalExitTimer = setTimeout(
              () => driver.symbols.PostMessageW(hwnd, 0x1f, 0n, 0n),
              MODAL_OBSERVATION_MS,
            );
            diagnose("modal-enter");
          }
          if (event.event === "modal-exit") {
            left = true;
            inModal = false;
            clearTimeout(modalExitTimer);
            diagnose("modal-exit");
          }
          if (event.event === "backend-tick") {
            latest = event;
            if (inModal) {
              during = latest;
            }
          }
        }
      },
    }),
  );
  const stderr = new Response(child.stderr).text();
  const timer = setTimeout(() => {
    try {
      diagnose("deadline");
    } finally {
      child.kill();
    }
  }, 60000);
  const code = await child.exited;
  clearTimeout(timer);
  try {
    await stdout;
  } finally {
    clearTimeout(modalExitTimer);
    driver.close();
  }
  console.log(text);
  console.error(await stderr);
  assert.equal(code, creationFailure ? 1 : 0);
  if (modal) {
    assert(entered && left);
    for (const key of [
      "ticks",
      "promises",
      "network",
    ] as const) {
      assert(during[key] > baseline[key], `${key} stalled during modal loop`);
    }
  }
  if (!earlyClose && !creationFailure) {
    const report = JSON.parse(
      await readFile(resolve(output, "report.json"), "utf8"),
    );
    assert.equal(report.pass, true);
  }
  console.log(
    `PASS Windows Bun ${modal ? "modal backend progress" : earlyClose ? "close during startup" : creationFailure ? "partial creation failure" : "SDK/core invoke/listen/cancel/setup/stop"}`,
  );
} else {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("network-ok"),
  });
  // The modal-loop case requires timers, microtasks, and real HTTP requests to keep progressing.
  let ticks = 0;
  let promises = 0;
  let network = 0;
  let cancelled = false;
  let setup = false;
  let stopped = false;
  const requests: Promise<void>[] = [];
  const timer = setInterval(() => {
    ticks++;
    void Promise.resolve().then(() => promises++);
    if (modal && ticks % 5 === 0) {
      requests.push(
        fetch(server.url)
          .then((response) => response.text())
          .then(() => {
            network++;
          }),
      );
    }
    if (modal && ticks % 10 === 0) {
      console.log(
        JSON.stringify({
          event: "backend-tick",
          ticks,
          promises,
          network,
        }),
      );
    }
  }, 10);
  const app: AppDefinition = {
    events: {
      "test.changed": {
        type: "integer",
      },
    },
    plugins: [
      log._definition,
      {
        name: "setup",
        version: "1",
        async setup(context) {
          // The command gate below requires setup; stop records that shutdown ran cleanup.
          await context.host.call(contracts["log.write"], {
            level: "info",
            message: "startup",
            details: null,
          });
          setup = true;
          return () => {
            stopped = true;
          };
        },
      },
    ],
    commands: {
      "test.echo": {
        input: {
          type: "integer",
        },
        output: {
          type: "integer",
        },
        async run(value) {
          assert(setup);
          assert.equal(await (await fetch(server.url)).text(), "network-ok");
          await Bun.sleep(100);
          assert(ticks > 5 && promises > 5);
          return Number(value) * 2;
        },
      },
      "test.emit": {
        input: {
          type: "integer",
        },
        output: {
          const: null,
        },
        async run(value, context) {
          await context.events.emit("test.changed", Number(value), {
            kind: "broadcast",
          });
          return null;
        },
      },
      "test.hold": {
        input: {
          const: null,
        },
        output: {},
        async run(_value, context) {
          return new Promise((_resolve, reject) => {
            context.signal.addEventListener("abort", () => {
              cancelled = true;
              reject(new Error("cancelled"));
            });
          });
        },
      },
      "test.report": {
        input: {
          const: true,
        },
        output: {
          const: null,
        },
        async run() {
          assert(cancelled);
          await writeFile(
            resolve(output, "report.json"),
            JSON.stringify({
              pass: true,
              ticks,
              promises,
            }),
          );
          return null;
        },
      },
    },
  };
  try {
    await runWindowsApp(app, {
      runtime: {
        id: "core-gate",
        generation: crypto.randomUUID(),
      },
      backendContext: "backend-core" as HostContext,
      policy,
      assets,
      dataRoot,
      loader: creationFailure
        ? resolve(output, "missing-loader.dll")
        : resolve(
            repoRoot,
            "build/cache/webview2/sdk/build/native/x64/WebView2Loader.dll",
          ),
      windows: [
        {
          view: "main",
          title: "Bunaway Bun core gate",
          home: "https://app.bunaway.local/index.html",
          window: {
            width: 640,
            height: 480,
          },
        },
      ],
    });
    if (!earlyClose) {
      assert(stopped);
    }
  } finally {
    clearInterval(timer);
    // Finish already-started requests before stopping the server they use.
    await Promise.all(requests);
    await server.stop(true);
  }
}
