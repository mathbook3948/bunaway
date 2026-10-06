// Standalone integration runner: native/macos/probe/run.sh builds the package first.
// POSIX runtime probe: mkfifo backpressure for stall tests,
// SIGTERM/SIGKILL for shutdown checks, --guard watchdog for host-death cleanup.
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, openSync, readSync, realpathSync, unlinkSync } from "node:fs";
import { cp, mkdir, writeFile } from "node:fs/promises";
import { release } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  type JsonValue,
  MAX_MESSAGE_BYTES,
  type Message,
  PROCESS_IPC_VERSION,
  PROTOCOL_VERSION,
  type ProcessFrame,
  serializeProcessFrame,
  validateValue,
} from "../../packages/protocol/src/index.ts";
import { readJsonLines } from "../../packages/runtime-bun/src/process-ipc.ts";
import { validationCases } from "../protocol/validation-cases.ts";

const original = resolve(process.argv[process.argv.indexOf("--package") + 1] ?? "");
assert.ok(process.argv.includes("--package"), "--package is required");
const packagePath = join(dirname(original), "macOS B 단계 한글 package");
await cp(original, packagePath, { recursive: true, force: true });
const cwd = join(dirname(original), "hostile-cwd");
await mkdir(cwd, { recursive: true });
await writeFile(join(cwd, ".env"), "BUNAWAY_HOSTILE=from-dotenv\n");
await writeFile(join(cwd, "bunfig.toml"), 'preload = ["./hostile.ts"]\n');
await writeFile(join(cwd, "hostile.ts"), 'throw new Error("hostile preload");');
const host = join(packagePath, "bunaway-probe");
const runtime = { id: "probe", generation: "1" };
const base = { ipc: PROCESS_IPC_VERSION, runtime };
type Observation = { kind: string; payload?: Message; [key: string]: unknown };
const live = new Set<ReturnType<typeof launch>>();
const results: { name: string; ok: boolean; durationMs: number; error?: string }[] = [];
const executions: (() => {
  mode: string;
  hostPid: number;
  frames: Observation[];
  stderrBytes: number;
  descendantPid: number | null;
})[] = [];

let fifoCounter = 0;
const fifoPaths: string[] = [];
function launch(mode = "normal", stall = false) {
  // Bun drains a subprocess's stdout eagerly into memory, so pausing the
  // consumer can never create OS-level backpressure through the pipe. For
  // stall tests the host's stdout is a FIFO the driver owns: pausing the
  // driver's reads fills the fifo (64 KiB) and the host sees real EAGAIN.
  let fifoFd = -1;
  let paused = false;
  const args = stall
    ? (() => {
        const fifoPath = join(cwd, `host-stdout-${process.pid}-${fifoCounter++}.fifo`);
        execSync(`mkfifo "${fifoPath}"`);
        fifoPaths.push(fifoPath);
        fifoFd = openSync(fifoPath, constants.O_RDWR | constants.O_NONBLOCK);
        // exec keeps the shell's pid, so child.pid is the host pid.
        return ["/bin/sh", "-c", 'exec "$1" "$2" >"$3"', "sh", host, mode, fifoPath];
      })()
    : [host, mode];
  const child = Bun.spawn(args, {
    cwd,
    env: {
      PATH: "/usr/bin:/bin",
      HOME: cwd,
      BUN_OPTIONS: "--preload ./hostile.ts",
      BUNAWAY_HOSTILE: "from-parent",
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const frames: Observation[] = [];
  let logs = "";
  let done = false;
  let readError: unknown;
  const releaseOutput = () => {
    paused = false;
  };
  let childExited = false;
  child.exited.then(() => {
    childExited = true;
  });
  let pendingLine = "";
  const feed = (text: string) => {
    pendingLine += text;
    let idx = pendingLine.indexOf("\n");
    while (idx >= 0) {
      const line = pendingLine.slice(0, idx);
      pendingLine = pendingLine.slice(idx + 1);
      try {
        frames.push(JSON.parse(line) as Observation);
      } catch (cause) {
        readError = cause;
      }
      idx = pendingLine.indexOf("\n");
    }
  };
  const output = stall
    ? (async () => {
        const buf = Buffer.alloc(65536);
        for (;;) {
          if (!paused) {
            try {
              const n = readSync(fifoFd, buf, 0, buf.length, null);
              if (n > 0) feed(buf.subarray(0, n).toString());
            } catch (cause) {
              if ((cause as { code?: string }).code !== "EAGAIN") readError = cause;
            }
          }
          if (childExited) {
            // Final drain: buffered bytes survive the last writer closing.
            for (;;) {
              let n = 0;
              try {
                n = readSync(fifoFd, buf, 0, buf.length, null);
              } catch {
                n = 0;
              }
              if (n <= 0) break;
              feed(buf.subarray(0, n).toString());
            }
            break;
          }
          await Bun.sleep(10);
        }
        done = true;
      })()
    : (async () => {
        try {
          for await (const line of readJsonLines(child.stdout)) {
            const frame = JSON.parse(line) as Observation;
            frames.push(frame);
          }
        } catch (cause) {
          readError = cause;
        } finally {
          done = true;
        }
      })();
  const stderr = (async () => {
    for await (const bytes of child.stderr) logs += new TextDecoder().decode(bytes);
  })();
  async function wait(match: (frame: Observation) => boolean, timeout = 8000) {
    const deadline = performance.now() + timeout;
    while (true) {
      const found = frames.find(match);
      if (found) return found;
      if (done || performance.now() > deadline)
        throw new Error(
          `Missing frame; ${JSON.stringify(frames)}; stderr=${logs.slice(0, 1000)}; read=${readError}`,
        );
      await Bun.sleep(5);
    }
  }
  const api = {
    child,
    releaseOutput,
    pauseOutput: () => {
      paused = true;
    },
    async waitForPartialResponse(id: string, payload: JsonValue) {
      assert.ok(paused && fifoFd >= 0, "A paused FIFO is required");
      const expected = serializeProcessFrame({
        kind: "web",
        ...base,
        context: "probe-view",
        payload: { kind: "result", protocol: PROTOCOL_VERSION, id, payload },
      });
      assert.ok(Buffer.byteLength(expected) > 65536, "Response must exceed the FIFO capacity");
      const deadline = performance.now() + 8000;
      const buffer = Buffer.alloc(512);
      while (pendingLine.length < 512) {
        assert.ok(!childExited && performance.now() < deadline, "Missing partial response");
        try {
          const n = readSync(fifoFd, buffer, 0, buffer.length, null);
          if (n > 0) feed(buffer.subarray(0, n).toString());
        } catch (cause) {
          if ((cause as { code?: string }).code !== "EAGAIN") throw cause;
        }
        assert.ok(expected.startsWith(pendingLine), "Unexpected partial response");
        if (pendingLine.length < 512) await Bun.sleep(5);
      }
      // Leave the large response in flight, with all remaining FIFO reads paused.
    },
    closeFifo() {
      if (fifoFd >= 0) {
        paused = false;
        closeSync(fifoFd);
        fifoFd = -1;
      }
    },
    async drainOutput() {
      await output;
      await stderr;
    },
    frames,
    wait,
    trace: () => ({
      mode,
      hostPid: child.pid,
      frames,
      stderrBytes: Buffer.byteLength(logs),
      descendantPid: Number(/descendant=(\d+)/.exec(logs)?.[1]) || null,
    }),
    logs: () => logs,
    async ready() {
      const started = await wait((frame) => frame.kind === "host-started");
      const ready = await wait((frame) => frame.kind === "ready");
      assert.equal(started.hostPid, child.pid);
      assert.equal(ready.pid, started.childPid);
      assert.notEqual(started.hostPid, started.childPid);
      assert.equal(
        realpathSync(started.bunPath as string),
        realpathSync(join(packagePath, "runtime/bun")),
      );
      return started.childPid as number;
    },
    send(frame: ProcessFrame) {
      child.stdin.write(`${serializeProcessFrame(frame)}\n`);
    },
    request(id: string, command: string, payload: JsonValue = null) {
      api.send({
        ...base,
        kind: "web",
        context: "probe-view",
        payload: { kind: "invoke", protocol: PROTOCOL_VERSION, id, command, payload },
      });
      return api.response(id);
    },
    async response(id: string) {
      const found = await wait(
        (frame) =>
          frame.kind === "web" &&
          (frame.payload?.kind === "result" || frame.payload?.kind === "error") &&
          frame.payload.id === id,
      );
      return found.payload as Extract<Message, { kind: "result" | "error" }>;
    },
    async finish(expectedExit = 0) {
      const stopped = await wait((frame) => frame.kind === "host-stopped", 12000);
      assert.equal(await child.exited, expectedExit);
      await output;
      await stderr;
      assert.equal(stopped.activeProcesses, 0);
      live.delete(api);
      return stopped;
    },
    async stop() {
      api.send({ ...base, kind: "shutdown" });
      return api.finish();
    },
  };
  live.add(api);
  executions.push(api.trace);
  return api;
}

// watch waits for PIDs and process groups ("g<pid>") to disappear via the
// same host binary's --watch mode.
async function watch(targets: (number | string)[]) {
  const watcher = Bun.spawn([host, "--watch", ...targets.map(String)], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = watcher.stdout.getReader();
  const first = await reader.read();
  reader.releaseLock();
  assert.equal(new TextDecoder().decode(first.value), "watch-ready\n");
  return async () => {
    assert.equal(await watcher.exited, 0, "Watched processes/group must be gone");
    assert.equal(await new Response(watcher.stderr).text(), "");
  };
}

async function test(name: string, body: () => Promise<void>) {
  const start = performance.now();
  try {
    await body();
  } catch (cause) {
    results.push({
      name,
      ok: false,
      durationMs: Math.round(performance.now() - start),
      error: String(cause),
    });
    throw new Error(`${name} failed`, { cause });
  }
  results.push({ name, ok: true, durationMs: Math.round(performance.now() - start) });
  console.log(`PASS ${name}`);
}

try {
  await test("TypeScript and native validators agree on shared regression inputs", async () => {
    const validator = Bun.spawn([host, "--validate"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = new Response(validator.stdout).text();
    const errors = new Response(validator.stderr).text();
    for (const { schema, value } of validationCases)
      validator.stdin.write(`${JSON.stringify({ schema, value })}\n`);
    validator.stdin.end();
    assert.equal(await validator.exited, 0);
    const answers = (await output)
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as boolean);
    assert.equal(answers.length, validationCases.length);
    for (const [i, { name, schema, value, accepted }] of validationCases.entries()) {
      let tsAccepted = true;
      try {
        validateValue(schema, value);
      } catch {
        tsAccepted = false;
      }
      assert.equal(tsAccepted, accepted, `TypeScript: ${name}`);
      assert.equal(answers[i], accepted, `native: ${name}`);
    }
    assert.equal(await errors, "");
  });
  for (const termination of ["EOF", "shutdown"] as const) {
    await test(`immediate controller ${termination} cancels startup normally`, async () => {
      for (let attempt = 0; attempt < 5; attempt++) {
        const probe = launch();
        if (termination === "EOF") probe.child.stdin.end();
        else probe.send({ ...base, kind: "shutdown" });
        const stopped = await probe.finish();
        assert.equal(stopped.exitCode, 0);
        assert.equal(stopped.failed, false);
        assert.equal(stopped.forced, false);
        assert.ok(probe.frames.some((frame) => frame.kind === "stopping"));
        assert.equal(
          probe.frames.some((frame) => frame.kind === "fatal" || frame.kind === "host-error"),
          false,
        );
      }
    });
  }
  await test("bundled Bun, distinct OS PID, Korean/space path, isolated environment", async () => {
    const probe = launch();
    const pid = await probe.ready();
    const exited = await watch([pid]);
    const response = await probe.request("environment", "probe.environment");
    assert.equal(response.kind, "result");
    if (response.kind !== "result") throw new Error("Expected environment");
    const env = response.payload as Record<string, JsonValue>;
    assert.equal(env.cwd, realpathSync(join(packagePath, "assets")));
    assert.equal(env.injected, null);
    assert.equal(env.bunOptions, null);
    assert.deepEqual(env.args, ["normal"]);
    assert.equal((await probe.stop()).failed, false);
    await exited();
  });
  await test("arithmetic, Promise, timer and out-of-order request correlation", async () => {
    const probe = launch();
    await probe.ready();
    const timer = probe.request("timer", "probe.timer");
    assert.deepEqual(await probe.request("add", "probe.add"), {
      kind: "result",
      protocol: PROTOCOL_VERSION,
      id: "add",
      payload: 4,
    });
    assert.equal(
      ((await probe.request("promise", "probe.promise")) as Extract<Message, { kind: "result" }>)
        .payload,
      42,
    );
    assert.equal(((await timer) as Extract<Message, { kind: "result" }>).payload, "timer-done");
    await probe.stop();
  });
  await test("subscribe, events, unlisten, late discard and context revocation", async () => {
    const probe = launch();
    await probe.ready();
    probe.send({
      ...base,
      kind: "web",
      context: "probe-view",
      payload: { kind: "listen", protocol: PROTOCOL_VERSION, id: "listen", event: "probe.changed" },
    });
    await probe.response("listen");
    await probe.request("emit", "probe.emit", { text: "한글 😀" });
    const event = await probe.wait((frame) => frame.payload?.kind === "event");
    assert.equal((event.payload as Extract<Message, { kind: "event" }>).sequence, 1);
    assert.deepEqual((event.payload as Extract<Message, { kind: "event" }>).payload, {
      text: "한글 😀",
    });
    probe.send({
      ...base,
      kind: "web",
      context: "probe-view",
      payload: {
        kind: "unlisten",
        protocol: PROTOCOL_VERSION,
        id: "unlisten",
        subscriptionId: "probe-sub",
      },
    });
    await probe.response("unlisten");
    await probe.request("late", "probe.late-event");
    await probe.wait(
      (frame) => frame.kind === "host-discarded" && frame.reason === "inactive-subscription",
    );
    probe.send({
      ...base,
      kind: "web",
      context: "probe-view",
      payload: {
        kind: "listen",
        protocol: PROTOCOL_VERSION,
        id: "listen2",
        event: "probe.changed",
      },
    });
    await probe.response("listen2");
    probe.send({ ...base, kind: "revoke", context: "probe-view" });
    assert.equal((await probe.request("revoked-late", "probe.late-event")).kind, "error");
    await probe.stop();
    assert.equal(probe.frames.filter((frame) => frame.payload?.kind === "event").length, 1);
    assert.equal(probe.frames.filter((frame) => frame.kind === "host-discarded").length, 1);
  });
  await test("revocation cancels pending requests and cannot be undone by a late listen result", async () => {
    const probe = launch("late-listen");
    await probe.ready();
    probe.send({
      ...base,
      kind: "web",
      context: "probe-view",
      payload: { kind: "listen", protocol: PROTOCOL_VERSION, id: "listen", event: "probe.changed" },
    });
    const pendingInvoke = probe.request("hold", "probe.hold");
    probe.send({ ...base, kind: "revoke", context: "probe-view" });
    for (const response of [await probe.response("listen"), await pendingInvoke]) {
      assert.equal(response.kind, "error");
      if (response.kind !== "error") throw new Error("Expected cancellation");
      assert.equal(response.error.code, "CANCELLED");
    }
    await probe.wait(
      (frame) => frame.kind === "host-discarded" && frame.reason === "late-response",
    );
    await probe.wait(
      (frame) => frame.kind === "host-discarded" && frame.reason === "inactive-subscription",
    );
    probe.send({
      ...base,
      kind: "web",
      context: "probe-view",
      payload: {
        kind: "listen",
        protocol: PROTOCOL_VERSION,
        id: "listen-again",
        event: "probe.changed",
      },
    });
    const again = await probe.response("listen-again");
    assert.equal(again.kind, "error");
    if (again.kind !== "error") throw new Error("Expected cancellation");
    assert.equal(again.error.code, "CANCELLED");
    await probe.stop();
    assert.equal(probe.frames.filter((frame) => frame.payload?.kind === "event").length, 0);
    for (const id of ["listen", "hold", "listen-again"]) {
      assert.equal(
        probe.frames.filter(
          (frame) =>
            frame.kind === "web" &&
            "id" in (frame.payload ?? {}) &&
            (frame.payload as { id: string }).id === id,
        ).length,
        1,
      );
    }
  });
  await test("throw and rejected Promise deliver sanitized errors", async () => {
    const probe = launch();
    await probe.ready();
    for (const operation of ["throw", "reject"]) {
      assert.deepEqual(await probe.request(operation, `probe.${operation}`), {
        kind: "error",
        protocol: PROTOCOL_VERSION,
        id: operation,
        error: { code: "INTERNAL", message: "Probe operation failed." },
      });
    }
    await probe.stop();
    assert.ok(!JSON.stringify(probe.frames).includes("private-details"));
  });
  await test("stderr flood drains without blocking IPC", async () => {
    const probe = launch();
    await probe.ready();
    assert.equal(
      ((await probe.request("logs", "probe.log-flood")) as Extract<Message, { kind: "result" }>)
        .payload,
      "logs-drained",
    );
    await probe.stop();
    assert.equal(Buffer.byteLength(probe.logs()), 65536);
  });
  await test("astral Unicode error message survives native IPC validation", async () => {
    const probe = launch();
    await probe.ready();
    const response = await probe.request("unicode-error", "probe.unicode-error");
    assert.equal(response.kind, "error");
    if (response.kind === "error") assert.equal(response.error.message, "😀".repeat(600));
    await probe.stop();
  });
  await test("unpaired surrogates are rejected before IPC without closing the host", async () => {
    const probe = launch();
    await probe.ready();
    for (const payload of ["\uD800", "\uDC00", { "\uD800": "key" }, { nested: ["\uDC00"] }]) {
      assert.throws(() =>
        probe.send({
          ...base,
          kind: "web",
          context: "probe-view",
          payload: {
            kind: "invoke",
            protocol: PROTOCOL_VERSION,
            id: "bad-unicode",
            command: "probe.echo",
            payload,
          },
        }),
      );
    }
    const payload = { "😀": ["\uD800\uDC00", "\uDBFF\uDFFF"] };
    const response = await probe.request("valid-unicode", "probe.echo", payload);
    assert.equal(response.kind, "result");
    if (response.kind === "result") assert.deepEqual(response.payload, payload);
    await probe.stop();
  });
  for (const action of ["direct", "invoke", "revoke", "ignore-stop", "no-shutdown"] as const) {
    const name =
      action === "no-shutdown"
        ? "blocked stdout remains bounded without controller shutdown"
        : `blocked stdout remains bounded through ${action} then shutdown`;
    await test(name, async () => {
      const probe = launch(action === "ignore-stop" ? "ignore-stop" : "normal", true);
      const pid = await probe.ready();
      const exited = await watch([pid]);
      probe.pauseOutput();
      probe.send({
        ...base,
        kind: "web",
        context: "probe-view",
        payload: {
          kind: "invoke",
          protocol: PROTOCOL_VERSION,
          id: "blocked",
          command: "probe.echo",
          payload: "x".repeat(800000),
        },
      });
      await probe.waitForPartialResponse("blocked", "x".repeat(800000));
      const started = performance.now();
      if (action === "invoke") {
        probe.send({
          ...base,
          kind: "web",
          context: "probe-view",
          payload: {
            kind: "invoke",
            protocol: PROTOCOL_VERSION,
            id: "next",
            command: "probe.add",
            payload: null,
          },
        });
      } else if (action === "revoke") {
        probe.send({ ...base, kind: "revoke", context: "probe-view" });
        probe.send({
          ...base,
          kind: "web",
          context: "probe-view",
          payload: {
            kind: "listen",
            protocol: PROTOCOL_VERSION,
            id: "revoked",
            event: "probe.changed",
          },
        });
      }
      if (action !== "no-shutdown") probe.send({ ...base, kind: "shutdown" });
      const exit = await Promise.race([probe.child.exited, Bun.sleep(4500).then(() => "timeout")]);
      assert.equal(exit, 1, "host must fail while stdout remains blocked");
      assert.ok(performance.now() - started < 4500);
      await exited();
      // Reading resumes only AFTER both host and Bun have exited.
      probe.releaseOutput();
      await probe.drainOutput();
      probe.closeFifo();
      live.delete(probe);
    });
  }
  await test("blocked controller output queue overflow cleans up without shutdown", async () => {
    const probe = launch("normal", true);
    const pid = await probe.ready();
    const exited = await watch([pid]);
    probe.pauseOutput();
    probe.send({
      ...base,
      kind: "web",
      context: "probe-view",
      payload: {
        kind: "invoke",
        protocol: PROTOCOL_VERSION,
        id: "blocked",
        command: "probe.echo",
        payload: "x".repeat(800000),
      },
    });
    await probe.waitForPartialResponse("blocked", "x".repeat(800000));
    // Each request produces a result and a late-response diagnostic. Pace requests
    // so output accumulates while the pending-request queue remains small.
    for (let i = 0; i < 200; i++) {
      probe.send({
        ...base,
        kind: "web",
        context: "probe-view",
        payload: {
          kind: "invoke",
          protocol: PROTOCOL_VERSION,
          id: `overflow-${i}`,
          command: "probe.late-response",
          payload: null,
        },
      });
      await Bun.sleep(15);
    }
    const exit = await Promise.race([probe.child.exited, Bun.sleep(8000).then(() => "timeout")]);
    assert.equal(exit, 1, "host must fail without controller consumption");
    await exited();
    probe.releaseOutput();
    await probe.drainOutput();
    probe.closeFifo();
    live.delete(probe);
  });
  await test("resuming stdout preserves response and revocation order", async () => {
    const probe = launch("normal", true);
    await probe.ready();
    probe.pauseOutput();
    probe.send({
      ...base,
      kind: "web",
      context: "probe-view",
      payload: {
        kind: "invoke",
        protocol: PROTOCOL_VERSION,
        id: "hold",
        command: "probe.hold",
        payload: null,
      },
    });
    probe.send({
      ...base,
      kind: "web",
      context: "probe-view",
      payload: {
        kind: "invoke",
        protocol: PROTOCOL_VERSION,
        id: "echo",
        command: "probe.echo",
        payload: "x".repeat(800000),
      },
    });
    await probe.waitForPartialResponse("echo", "x".repeat(800000));
    probe.send({ ...base, kind: "revoke", context: "probe-view" });
    probe.send({
      ...base,
      kind: "web",
      context: "probe-view",
      payload: {
        kind: "listen",
        protocol: PROTOCOL_VERSION,
        id: "after-revoke",
        event: "probe.changed",
      },
    });
    probe.releaseOutput();
    const echo = await probe.response("echo");
    assert.equal(echo.kind, "result");
    if (echo.kind !== "result") throw new Error("Expected echo result");
    assert.equal((echo.payload as string).length, 800000);
    for (const id of ["hold", "after-revoke"]) {
      const response = await probe.response(id);
      assert.equal(response.kind, "error");
      if (response.kind !== "error") throw new Error("Expected cancellation");
      assert.equal(response.error.code, "CANCELLED");
    }
    await probe.stop();
    const responses = probe.frames.flatMap((frame) => {
      if (
        frame.kind === "web" &&
        (frame.payload?.kind === "result" || frame.payload?.kind === "error")
      )
        return [frame.payload.id];
      return [];
    });
    assert.deepEqual(responses, ["echo", "hold", "after-revoke"]);
    assert.equal(probe.frames.filter((frame) => frame.payload?.kind === "event").length, 0);
  });
  await test("split/coalesced UTF-8 frames and IDs beyond JS integer precision", async () => {
    const probe = launch();
    await probe.ready();
    const first = serializeProcessFrame({
      ...base,
      kind: "web",
      context: "probe-view",
      payload: {
        kind: "invoke",
        protocol: PROTOCOL_VERSION,
        id: "9007199254740993",
        command: "probe.add",
        payload: "한글 😀",
      },
    });
    const bytes = Buffer.from(`${first}\n`);
    const at = bytes.indexOf(Buffer.from("한")) + 1;
    probe.child.stdin.write(bytes.subarray(0, at));
    await Bun.sleep(5);
    probe.child.stdin.write(bytes.subarray(at));
    const lines = ["b", "c"].map((id) =>
      serializeProcessFrame({
        ...base,
        kind: "web",
        context: "probe-view",
        payload: {
          kind: "invoke",
          protocol: PROTOCOL_VERSION,
          id,
          command: "probe.promise",
          payload: null,
        },
      }),
    );
    probe.child.stdin.write(`${lines.join("\n")}\n`);
    for (const id of ["9007199254740993", "b", "c"])
      assert.equal((await probe.response(id)).kind, "result");
    await probe.stop();
  });
  await test("shutdown cancels pending timer and waits for actual exit", async () => {
    const probe = launch();
    const pid = await probe.ready();
    const exited = await watch([pid]);
    const pending = probe.request("pending-timer", "probe.hold");
    probe.send({ ...base, kind: "shutdown" });
    assert.equal((await pending).kind, "error");
    await probe.finish();
    await exited();
  });
  await test("backend crash fails pending request and records exit status", async () => {
    const probe = launch();
    const pid = await probe.ready();
    const exited = await watch([pid]);
    const response = await probe.request("crash", "probe.crash");
    assert.equal(response.kind, "error");
    const stopped = await probe.finish(1);
    assert.equal(stopped.exitCode, 17);
    assert.equal(stopped.failed, true);
    await exited();
  });
  await test("backend stdout EOF fails pending requests while Bun is still alive", async () => {
    const probe = launch();
    const pid = await probe.ready();
    const exited = await watch([pid]);
    const pending = probe.request("held", "probe.hold");
    const close = probe.request("close-stdout", "probe.close-stdout");
    const started = performance.now();
    const [held, closed] = await Promise.all([pending, close]);
    assert.equal(held.kind, "error");
    assert.equal(closed.kind, "error");
    assert.equal((await probe.finish(1)).failed, true);
    assert.ok(performance.now() - started < 4500);
    await exited();
  });
  await test("shutdown timeout forcibly kills Bun", async () => {
    const probe = launch("ignore-stop");
    const pid = await probe.ready();
    const exited = await watch([pid]);
    probe.send({ ...base, kind: "shutdown" });
    const stopped = await probe.finish(1);
    assert.equal(stopped.forced, true);
    await exited();
  });
  for (const termination of ["normal", "kill"] as const) {
    await test(`${termination} host exit kills Bun and its descendant`, async () => {
      const probe = launch("child");
      const pid = await probe.ready();
      const deadline = performance.now() + 5000;
      while (!probe.logs().includes("descendant=") && performance.now() < deadline)
        await Bun.sleep(5);
      const descendant = Number(/descendant=(\d+)/.exec(probe.logs())?.[1]);
      assert.ok(descendant > 0);
      const exited = await watch([pid, descendant, `g${pid}`]);
      if (termination === "normal") await probe.stop();
      else {
        probe.child.kill("SIGKILL");
        await probe.child.exited;
        live.delete(probe);
      }
      await exited();
    });
  }
  await test("controller EOF shuts down Bun", async () => {
    const probe = launch();
    await probe.ready();
    probe.child.stdin.end();
    await probe.finish();
  });
  for (const mode of ["json", "utf8", "large", "partial", "stdout", "stale", "version", "eof"]) {
    await test(`backend ${mode} failure closes the runtime`, async () => {
      const probe = launch(`fault-${mode}`);
      const stopped = await probe.finish(1);
      assert.equal(stopped.failed, true);
    });
  }
  for (const [name, bytes] of [
    ["malformed JSON", Buffer.from("bad\n")],
    ["invalid UTF-8", Buffer.from([255, 10])],
    ["oversized frame", Buffer.from(`${"x".repeat(1_048_577)}\n`)],
    ["incomplete EOF", Buffer.from("{")],
    ["empty frame", Buffer.from("\n")],
    [
      "wrong generation",
      Buffer.from(
        `${JSON.stringify({ ...base, runtime: { id: "probe", generation: "0" }, kind: "shutdown" })}\n`,
      ),
    ],
  ] as const) {
    await test(`controller ${name} is rejected`, async () => {
      const probe = launch();
      await probe.ready();
      probe.child.stdin.write(bytes);
      probe.child.stdin.end();
      const stopped = await probe.finish(1);
      assert.equal(stopped.failed, true);
    });
  }
  await test("request IDs cannot be reused", async () => {
    const probe = launch();
    await probe.ready();
    await probe.request("same", "probe.add");
    probe.send({
      ...base,
      kind: "web",
      context: "probe-view",
      payload: {
        kind: "invoke",
        protocol: PROTOCOL_VERSION,
        id: "same",
        command: "probe.add",
        payload: null,
      },
    });
    assert.equal((await probe.finish(1)).failed, true);
  });
  await test("late duplicate response is discarded", async () => {
    const probe = launch();
    await probe.ready();
    await probe.request("late-response", "probe.late-response");
    await probe.wait(
      (frame) => frame.kind === "host-discarded" && frame.reason === "late-response",
    );
    await probe.stop();
    assert.equal(probe.frames.filter((frame) => frame.payload?.kind === "result").length, 1);
  });
  await test("native numbers and duplicate keys match JavaScript parsing", async () => {
    const probe = launch();
    await probe.ready();
    const text =
      '{"kind":"web","ipc":{"major":1,"minor":0},"runtime":{"id":"probe","generation":"1"},"context":"probe-view","payload":{"kind":"invoke","protocol":{"major":1,"minor":0},"id":"echo","command":"probe.echo","payload":{"n":9007199254740993,"z":-0,"nested":{"value":1,"value":2}}}}';
    probe.child.stdin.write(`${text}\n`);
    const response = await probe.response("echo");
    assert.equal(response.kind, "result");
    if (response.kind === "result")
      assert.deepEqual(response.payload, { n: 9007199254740992, z: 0, nested: { value: 2 } });
    await probe.stop();
  });
  for (const direction of ["echo", "backend"] as const) {
    await test(`near-limit numeric array survives ${direction} relay without disconnecting`, async () => {
      const probe = launch();
      await probe.ready();
      const id = `numbers-${direction}`;
      const command = direction === "echo" ? "probe.echo" : "probe.number-array";
      const emptyFrame: ProcessFrame = {
        ...base,
        kind: "web",
        context: "probe-view",
        payload:
          direction === "echo"
            ? { kind: "invoke", protocol: PROTOCOL_VERSION, id, command, payload: [] }
            : { kind: "result", protocol: PROTOCOL_VERSION, id, payload: [] },
      };
      // N values add N * (token bytes + comma) - 1 bytes to the empty array.
      const tokenBytes = JSON.stringify(1e-7).length + 1;
      const count = Math.floor(
        (MAX_MESSAGE_BYTES - Buffer.byteLength(serializeProcessFrame(emptyFrame)) + 1) / tokenBytes,
      );
      const numbers = Array<number>(count).fill(1e-7);
      if (emptyFrame.payload.kind !== "invoke" && emptyFrame.payload.kind !== "result")
        throw new Error("Expected numeric array frame");
      const boundaryFrame: ProcessFrame = {
        ...emptyFrame,
        payload: { ...emptyFrame.payload, payload: numbers },
      };
      const size = Buffer.byteLength(serializeProcessFrame(boundaryFrame));
      assert.ok(size <= MAX_MESSAGE_BYTES && size > MAX_MESSAGE_BYTES - tokenBytes);
      const response = await probe.request(id, command, direction === "echo" ? numbers : count);
      assert.equal(response.kind, "result");
      if (response.kind !== "result") throw new Error("Expected numeric array");
      assert.deepEqual(response.payload, numbers);
      const followup = await probe.request("still-alive", "probe.add");
      assert.equal(followup.kind, "result");
      if (followup.kind !== "result") throw new Error("Expected followup result");
      assert.equal(followup.payload, 4);
      assert.equal(
        probe.frames.some((frame) => frame.kind === "host-error"),
        false,
      );
      assert.equal((await probe.stop()).failed, false);
    });
  }
  for (const command of ["probe.add", "probe.echo"] as const) {
    await test(`compact large numbers are received and ${command} keeps the runtime alive`, async () => {
      const probe = launch();
      await probe.ready();
      const request = {
        ...base,
        kind: "web",
        context: "probe-view",
        payload: {
          kind: "invoke",
          protocol: PROTOCOL_VERSION,
          id: "compact",
          command,
          payload: "NUMBERS",
        },
      };
      const text = JSON.stringify(request).replace(
        '"NUMBERS"',
        `[${Array<string>(50000).fill("1e20").join(",")}]`,
      );
      assert.ok(Buffer.byteLength(text) < MAX_MESSAGE_BYTES);
      assert.ok(Buffer.byteLength(JSON.stringify(JSON.parse(text))) > MAX_MESSAGE_BYTES);
      // More failures than queue slots must not consume output capacity.
      const attempts = command === "probe.echo" ? 129 : 1;
      for (let i = 0; i < attempts; i++) {
        const id = `compact-${i}`;
        probe.child.stdin.write(`${text.replace('"id":"compact"', `"id":"${id}"`)}\n`);
        const response = await probe.response(id);
        if (command === "probe.add") {
          assert.equal(response.kind, "result");
          if (response.kind !== "result") throw new Error("Expected sum");
          assert.equal(response.payload, 4);
        } else {
          assert.equal(response.kind, "error");
          if (response.kind !== "error") throw new Error("Expected oversized response error");
          assert.equal(response.error.code, "INTERNAL");
        }
      }
      const followup = await probe.request("followup", "probe.add");
      assert.equal(followup.kind, "result");
      assert.equal(
        probe.frames.some((frame) => frame.kind === "host-error" || frame.kind === "fatal"),
        false,
      );
      assert.equal((await probe.stop()).failed, false);
    });
  }
  await test("native input accepts exactly 1 MiB", async () => {
    const probe = launch();
    await probe.ready();
    const frame: ProcessFrame = {
      ...base,
      kind: "web",
      context: "probe-view",
      payload: {
        kind: "invoke",
        protocol: PROTOCOL_VERSION,
        id: "max",
        command: "probe.add",
        payload: "",
      },
    };
    if (frame.payload.kind !== "invoke") throw new Error("Expected invoke");
    const large: ProcessFrame = {
      ...frame,
      payload: {
        ...frame.payload,
        payload: "x".repeat(MAX_MESSAGE_BYTES - Buffer.byteLength(serializeProcessFrame(frame))),
      },
    };
    assert.equal(Buffer.byteLength(serializeProcessFrame(large)), MAX_MESSAGE_BYTES);
    probe.send(large);
    assert.equal((await probe.response("max")).kind, "result");
    await probe.stop();
  });
  for (const [depth, accepted] of [
    [64, true],
    [65, false],
  ] as const) {
    await test(`native JSON depth ${depth} ${accepted ? "accepted" : "rejected"}`, async () => {
      const probe = launch();
      await probe.ready();
      let payload: JsonValue = 0;
      for (let i = 0; i < depth - 2; i++) payload = { child: payload };
      const frame = {
        ...base,
        kind: "web",
        context: "probe-view",
        payload: {
          kind: "invoke",
          protocol: PROTOCOL_VERSION,
          id: "depth",
          command: "probe.add",
          payload,
        },
      };
      probe.child.stdin.write(`${JSON.stringify(frame)}\n`);
      if (accepted) {
        assert.equal((await probe.response("depth")).kind, "result");
        await probe.stop();
      } else assert.equal((await probe.finish(1)).failed, true);
    });
  }
  await test("pending request limit rejects overload without leaving Bun", async () => {
    const probe = launch();
    await probe.ready();
    const lines = Array.from({ length: 129 }, (_, i) =>
      serializeProcessFrame({
        ...base,
        kind: "web",
        context: "probe-view",
        payload: {
          kind: "invoke",
          protocol: PROTOCOL_VERSION,
          id: `hold-${i}`,
          command: "probe.hold",
          payload: null,
        },
      }),
    );
    probe.child.stdin.write(`${lines.join("\n")}\n`);
    assert.equal((await probe.finish(1)).failed, true);
    assert.equal(probe.frames.filter((frame) => frame.payload?.kind === "error").length, 128);
  });
  console.log(`macOS process probe: ${results.length} passed.`);
} finally {
  for (const probe of live) {
    probe.child.kill();
    probe.child.stdin.end();
    probe.releaseOutput();
    probe.closeFifo();
  }
  await Promise.all([...live].map((probe) => probe.child.exited));
  for (const path of fifoPaths) {
    try {
      unlinkSync(path);
    } catch {}
  }
  const manifest = await Bun.file(join(original, "manifest.json")).json();
  const hostSha256 = createHash("sha256")
    .update(await Bun.file(host).bytes())
    .digest("hex");
  await writeFile(
    join(dirname(original), "macos-probe-results.json"),
    `${JSON.stringify({ testedAt: new Date().toISOString(), platform: process.platform, osRelease: release(), architecture: process.arch, packagePath, hostSha256, manifest, count: results.length, results, executions: executions.map((trace) => trace()) }, null, 2)}\n`,
  );
}
