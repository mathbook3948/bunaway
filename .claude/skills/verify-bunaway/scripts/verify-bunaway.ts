#!/usr/bin/env bun
/**
 * Drives a generated bunaway app the way its developer and its host do, on any OS that runs Bun.
 *
 * Subcommands (run with `bun .claude/skills/verify-bunaway/scripts/verify-bunaway.ts <command>`):
 *
 *   pack <packagesDir>                        Pack the framework from this checkout into tarballs.
 *   create <projectDir> --packages <dir>      Generate a project with the packed CLI and install it.
 *          [--template vanilla|vite|react|vue|svelte]
 *   doctor <projectDir>                       Read-only: is this project worth driving?
 *   backend <projectDir> [--evidence <dir>]   Boot the app's backend over the host process protocol,
 *                                             open an SDK channel, run message.save and message.read,
 *                                             and record every frame.
 *   web <projectDir> [--evidence <dir>]       Start the template's web dev server and fetch the page.
 *   clean <projectDir>                        Remove the project. Evidence directories are kept.
 *
 * The backend drive plays the native host's role: it answers the host operations the app's
 * commands request (storage.writeText, storage.readText, log.write) from an in-process store that
 * it writes into the evidence directory. Native plugin implementations therefore stay unverified
 * here; they run only under the real hosts (`mise run host:windows`, `mise run host:macos`).
 */
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const REPOSITORY = resolve(import.meta.dir, "../../../..");
const REQUIRED_BUN = "1.4.2";
/** Framework pack plus a cold `bun install` of a generated project stay well inside this. */
const SETUP_TIMEOUT_MS = 300_000;
/** One backend step: a frame round trip or a WebSocket reply. */
const STEP_TIMEOUT_MS = 10_000;
/** The web dev server must answer its first request inside this. */
const WEB_READY_TIMEOUT_MS = 30_000;
const PROTOCOL_VERSION = {
  major: 1,
  minor: 0,
};
const RUNTIME = {
  id: "verify",
  generation: "1",
};

type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | {
      [key: string]: Json;
    };
type Frame = Record<string, Json>;

function fail(message: string): never {
  console.error(`verify-bunaway: ${message}`);
  process.exit(1);
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

async function run(
  command: string[],
  cwd: string,
  timeoutMs = SETUP_TIMEOUT_MS,
): Promise<string> {
  const child = Bun.spawn(command, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    timeout: timeoutMs,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    fail(`${command.join(" ")} exited ${exitCode}\n${stdout}\n${stderr}`);
  }
  return stdout;
}

async function pack(packagesDir: string): Promise<void> {
  await mkdir(packagesDir, {
    recursive: true,
  });
  await run(
    [
      process.execPath,
      "run",
      "framework:pack",
      "--local",
      packagesDir,
    ],
    REPOSITORY,
  );
  console.log(`packed framework into ${packagesDir}`);
}

/**
 * The packed CLI's entry, extracted once into the OS temp directory. It must sit outside any
 * `node_modules` ancestor so Bun auto-installs the CLI's esbuild dependency into its cache, as the
 * repository's own CLI tests do; installing inside the artifact would fail its inventory audit.
 */
async function packedCli(packagesDir: string): Promise<string> {
  const unpacked = resolve(
    tmpdir(),
    `bunaway-verify-cli-${Bun.hash(packagesDir).toString(16)}`,
  );
  const entry = resolve(
    unpacked,
    "package/packages/cli/dist/distribution-main.js",
  );
  if (!(await Bun.file(entry).exists())) {
    await mkdir(unpacked, {
      recursive: true,
    });
    await run(
      [
        "tar",
        "-xzf",
        resolve(packagesDir, "bunaway-cli-0.0.0.tgz"),
        "-C",
        unpacked,
      ],
      packagesDir,
    );
  }
  return entry;
}

async function create(projectDir: string, args: string[]): Promise<void> {
  const packagesDir = option(args, "--packages");
  if (!packagesDir) {
    fail("create needs --packages <dir> from the pack step");
  }
  const template = option(args, "--template") ?? "vanilla";
  const cli = await packedCli(resolve(packagesDir));
  await run(
    [
      process.execPath,
      cli,
      "create",
      projectDir,
      "--template",
      template,
      "--package-dir",
      resolve(packagesDir),
    ],
    REPOSITORY,
  );
  await run(
    [
      process.execPath,
      "install",
    ],
    projectDir,
  );
  console.log(`created ${template} project at ${projectDir}`);
}

async function doctor(projectDir: string): Promise<void> {
  let ok = true;
  const check = (name: string, passed: boolean, detail: string) => {
    console.log(`${passed ? "OK" : "FAIL"} ${name}: ${detail}`);
    ok &&= passed;
  };
  check(
    "bun",
    Bun.version === REQUIRED_BUN,
    `${Bun.version}; the framework pins ${REQUIRED_BUN}`,
  );
  const settings = resolve(projectDir, "src-bunaway/bunaway.json");
  check(
    "settings",
    await Bun.file(settings).exists(),
    `${settings} ${(await Bun.file(settings).exists()) ? "present" : "missing"}`,
  );
  const runtime = resolve(projectDir, "node_modules/@bunaway/runtime-bun");
  check(
    "install",
    await Bun.file(resolve(runtime, "package.json")).exists(),
    `${runtime} ${(await Bun.file(resolve(runtime, "package.json")).exists()) ? "installed" : "missing; run create or bun install"}`,
  );
  if (!ok) {
    // No project to validate; spawning inside a missing directory would only report ENOENT.
    process.exit(1);
  }
  const validate = Bun.spawnSync(
    [
      process.execPath,
      "run",
      "validate",
    ],
    {
      cwd: projectDir,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  check(
    "validate",
    validate.exitCode === 0,
    `${validate.stdout.toString().trim()}${validate.stderr.toString().trim()}`,
  );
  if (!ok) {
    process.exit(1);
  }
}

/** Reads newline-delimited JSON frames from the backend's stdout, one `next()` per frame. */
function frameReader(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  const lines: string[] = [];
  return async (): Promise<Frame> => {
    while (lines.length === 0) {
      const { value, done } = await reader.read();
      if (done) {
        throw new Error("backend closed stdout");
      }
      buffered += decoder.decode(value, {
        stream: true,
      });
      const parts = buffered.split("\n");
      buffered = parts.pop() ?? "";
      lines.push(...parts.filter((line) => line.length > 0));
    }
    return JSON.parse(lines.shift() as string) as Frame;
  };
}

function withDeadline<T>(promise: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`timed out after ${STEP_TIMEOUT_MS} ms: ${what}`)),
      STEP_TIMEOUT_MS,
    );
  });
  return Promise.race([
    promise,
    deadline,
  ]).finally(() => clearTimeout(timer));
}

/**
 * The host side of the operations the template's commands request. Values live in `store` and
 * are mirrored into the evidence directory so a proof can show the side effect.
 */
function fakeHost(store: Map<string, string>) {
  return (operation: string, payload: Json): Frame => {
    const input = (payload ?? {}) as Record<string, Json>;
    if (operation === "storage.writeText") {
      store.set(String(input.path), String(input.text));
      return {
        kind: "result",
        payload: null,
      };
    }
    if (operation === "storage.readText") {
      const text = store.get(String(input.path));
      return text === undefined
        ? {
            kind: "error",
            error: {
              code: "NOT_FOUND",
              message: `No stored text at ${String(input.path)}`,
            },
          }
        : {
            kind: "result",
            payload: text,
          };
    }
    if (operation === "log.write") {
      return {
        kind: "result",
        payload: null,
      };
    }
    return {
      kind: "error",
      error: {
        code: "UNSUPPORTED",
        message: `verify-bunaway's host does not implement ${operation}`,
      },
    };
  };
}

async function backend(projectDir: string, args: string[]): Promise<void> {
  const evidence = resolve(
    option(args, "--evidence") ?? resolve(REPOSITORY, "build/verify-bunaway"),
  );
  await mkdir(evidence, {
    recursive: true,
  });
  const settings = (await Bun.file(
    resolve(projectDir, "src-bunaway/bunaway.json"),
  ).json()) as {
    app: {
      appId: string;
      title: string;
    };
  };
  const policy = (await Bun.file(
    resolve(projectDir, "src-bunaway/policy.json"),
  ).json()) as {
    views: {
      id: string;
      origins: string[];
    }[];
  };
  const view = policy.views[0];
  if (!view?.origins[0]) {
    fail("policy.json declares no view with an origin");
  }
  const origin = view.origins[0];
  // The entry plays the host's bundler: it hands the app definition to the process runtime.
  const entryDir = resolve(projectDir, ".bunaway-verify");
  await mkdir(entryDir, {
    recursive: true,
  });
  const entry = resolve(entryDir, "entry.ts");
  await Bun.write(
    entry,
    [
      'import { runBunApp } from "@bunaway/runtime-bun";',
      'import app from "../src-bunaway/app.ts";',
      "await runBunApp(app, {",
      `  app: ${JSON.stringify({
        name: settings.app.title,
        identifier: settings.app.appId,
        version: "0.0.0",
        framework: null,
        isPackaged: false,
        paths: null,
      })},`,
      "});",
      "",
    ].join("\n"),
  );
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      entry,
    ],
    {
      cwd: projectDir,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const stderr = new Response(child.stderr).text();
  const next = frameReader(child.stdout);
  const log: {
    direction:
      | "host->backend"
      | "backend->host"
      | "sdk->backend"
      | "backend->sdk";
    message: Json;
  }[] = [];
  const send = (frame: Frame) => {
    log.push({
      direction: "host->backend",
      message: frame,
    });
    child.stdin.write(
      `${JSON.stringify({
        ...frame,
        ipc: PROTOCOL_VERSION,
        runtime: RUNTIME,
      })}\n`,
    );
  };
  const store = new Map<string, string>();
  const host = fakeHost(store);
  // Host requests arrive interleaved with the frames a step waits for, so answer them in passing.
  const receive = async (kind: string): Promise<Frame> => {
    for (;;) {
      const frame = await withDeadline(next(), `waiting for ${kind}`);
      log.push({
        direction: "backend->host",
        message: frame,
      });
      if (frame.kind === "host-request") {
        send({
          kind: "host-response",
          context: frame.context as string,
          requestId: frame.requestId as string,
          payload: host(frame.operation as string, frame.payload as Json),
        });
        continue;
      }
      if (frame.kind === kind) {
        return frame;
      }
      throw new Error(`expected ${kind}, got ${JSON.stringify(frame)}`);
    }
  };
  const stamp = `verified at ${new Date().toISOString()}`;
  let socket: WebSocket | undefined;
  const report: Record<string, Json> = {
    project: projectDir,
    pass: false,
  };
  try {
    send({
      kind: "boot",
      payload: {
        entrypoint: entry,
        buildId: "verify",
        backendContext: "verify-backend",
        policy: policy as unknown as Json,
      },
    });
    await receive("hello");
    send({
      kind: "hello",
      payload: {
        kind: "hello",
        protocol: PROTOCOL_VERSION,
        features: [],
        buildId: "verify",
      },
    });
    const ready = await receive("ready");
    report.backendPid = ready.pid ?? null;
    send({
      kind: "session-open",
      context: "verify-view",
      viewId: view.id,
    });
    send({
      kind: "channel-open",
      context: "verify-view",
      nonce: "verify-nonce",
      origin,
    });
    const grant = await receive("channel-ready");
    const url = String(grant.url);
    if (!url) {
      throw new Error("backend granted no loopback channel URL");
    }
    socket = new WebSocket(url, {
      headers: {
        Origin: origin,
      },
    });
    const opened = Promise.withResolvers<void>();
    socket.onopen = () => opened.resolve();
    socket.onerror = () => opened.reject(new Error("loopback channel refused"));
    await withDeadline(opened.promise, "loopback channel open");
    const inbox: Json[] = [];
    let wake: (() => void) | undefined;
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as Json;
      log.push({
        direction: "backend->sdk",
        message,
      });
      inbox.push(message);
      wake?.();
    };
    // Host requests still arrive on stdout while the SDK waits, so keep draining them.
    const pump = (async () => {
      try {
        for (;;) {
          await receive("never");
        }
      } catch {
        // The backend is shutting down or a step failed; the step reports it.
      }
    })();
    const sdkSend = (message: Record<string, Json>) => {
      log.push({
        direction: "sdk->backend",
        message,
      });
      socket?.send(
        JSON.stringify({
          protocol: PROTOCOL_VERSION,
          ...message,
        }),
      );
    };
    const sdkReceive = async (
      predicate: (message: Record<string, Json>) => boolean,
      what: string,
    ): Promise<Record<string, Json>> => {
      for (;;) {
        const index = inbox.findIndex((message) =>
          predicate(message as Record<string, Json>),
        );
        if (index !== -1) {
          return inbox.splice(index, 1)[0] as Record<string, Json>;
        }
        await withDeadline(
          new Promise<void>((resolve) => {
            wake = resolve;
          }),
          what,
        );
      }
    };
    sdkSend({
      kind: "hello",
      features: [],
      buildId: "verify",
    });
    await sdkReceive((message) => message.kind === "hello", "SDK hello");
    sdkSend({
      kind: "listen",
      id: "listen-1",
      event: "message.saved",
    });
    const listening = await sdkReceive(
      (message) => message.id === "listen-1",
      "listen result",
    );
    const subscriptionId = (listening.payload as Record<string, Json>)
      ?.subscriptionId;
    sdkSend({
      kind: "invoke",
      id: "save-1",
      command: "message.save",
      payload: stamp,
    });
    const saved = await sdkReceive(
      (message) => message.id === "save-1",
      "message.save result",
    );
    if (saved.kind !== "result") {
      throw new Error(`message.save failed: ${JSON.stringify(saved)}`);
    }
    const event = await sdkReceive(
      (message) =>
        message.kind === "event" && message.event === "message.saved",
      "message.saved event",
    );
    sdkSend({
      kind: "invoke",
      id: "read-1",
      command: "message.read",
      payload: null,
    });
    const read = await sdkReceive(
      (message) => message.id === "read-1",
      "message.read result",
    );
    if (read.kind !== "result" || read.payload !== stamp) {
      throw new Error(`message.read returned ${JSON.stringify(read)}`);
    }
    report.saved = stamp;
    report.event = event;
    report.subscriptionId = subscriptionId ?? null;
    report.hostStore = Object.fromEntries(store);
    sdkSend({
      kind: "close",
    });
    socket.close();
    send({
      kind: "shutdown",
    });
    await pump;
    report.exitCode = await withDeadline(child.exited, "backend exit");
    report.pass = report.exitCode === 0;
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
  } finally {
    socket?.close();
    child.kill();
    await child.exited;
    report.stderr = await stderr;
    report.frames = log as unknown as Json;
    await Bun.write(
      resolve(evidence, "backend.json"),
      JSON.stringify(report, null, 2),
    );
    for (const [path, text] of store) {
      await Bun.write(
        resolve(
          evidence,
          "host-store",
          path.replaceAll(/[^A-Za-z0-9._-]/g, "_"),
        ),
        text,
      );
    }
  }
  console.log(
    `${report.pass ? "PASS" : "FAIL"} backend drive; evidence in ${resolve(evidence, "backend.json")}`,
  );
  if (!report.pass) {
    console.error(String(report.error ?? report.stderr));
    process.exit(1);
  }
}

async function web(projectDir: string, args: string[]): Promise<void> {
  const evidence = resolve(
    option(args, "--evidence") ?? resolve(REPOSITORY, "build/verify-bunaway"),
  );
  await mkdir(evidence, {
    recursive: true,
  });
  const settings = (await Bun.file(
    resolve(projectDir, "src-bunaway/bunaway.json"),
  ).json()) as {
    dev?: {
      command: string[];
      url: string;
    };
  };
  if (!settings.dev) {
    fail(
      "this template has no web dev server (vanilla serves static files); use a vite, react, vue or svelte project",
    );
  }
  const reservation = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(""),
  });
  const port = reservation.port;
  reservation.stop(true);
  const url = `http://127.0.0.1:${port}/`;
  const [command, ...rest] = settings.dev.command;
  if (!command) {
    fail("dev.command in src-bunaway/bunaway.json is empty");
  }
  const server = Bun.spawn(
    [
      command === "bun" ? process.execPath : command,
      ...rest,
      "--port",
      String(port),
    ],
    {
      cwd: projectDir,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const report: Record<string, Json> = {
    project: projectDir,
    url,
    pass: false,
  };
  try {
    const started = Date.now();
    let html = "";
    while (Date.now() - started < WEB_READY_TIMEOUT_MS) {
      try {
        const response = await fetch(url);
        if (response.ok) {
          html = await response.text();
          break;
        }
      } catch {
        // Not listening yet.
      }
      await Bun.sleep(250);
    }
    report.html = html;
    report.pass = html.includes('src="/@vite/client"');
    if (!report.pass) {
      report.error = html
        ? "page served without the Vite client script"
        : `no response within ${WEB_READY_TIMEOUT_MS} ms`;
    }
  } finally {
    server.kill();
    await server.exited;
    report.serverStderr = await new Response(server.stderr).text();
    await Bun.write(
      resolve(evidence, "web.json"),
      JSON.stringify(report, null, 2),
    );
  }
  console.log(
    `${report.pass ? "PASS" : "FAIL"} web dev server at ${url}; evidence in ${resolve(evidence, "web.json")}`,
  );
  if (!report.pass) {
    process.exit(1);
  }
}

async function clean(projectDir: string): Promise<void> {
  await rm(projectDir, {
    recursive: true,
    force: true,
  });
  console.log(`removed ${projectDir}`);
}

const [command, target, ...rest] = process.argv.slice(2);
if (!command || !target) {
  fail(
    "usage: verify-bunaway.ts <pack|create|doctor|backend|web|clean> <dir> [options]",
  );
}
const directory = resolve(target);
switch (command) {
  case "pack":
    await pack(directory);
    break;
  case "create":
    await create(directory, rest);
    break;
  case "doctor":
    await doctor(directory);
    break;
  case "backend":
    await backend(directory, rest);
    break;
  case "web":
    await web(directory, rest);
    break;
  case "clean":
    await clean(directory);
    break;
  default:
    fail(`unknown command ${command}`);
}
