import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createClient } from "../../packages/client-sdk/src/index.ts";
import { bundleAssets } from "../../packages/cli/src/build.ts";
import { validateProject } from "../../packages/cli/src/config.ts";
import { createProject } from "../../packages/cli/src/create.ts";
import {
  parseHostCall,
  parseProcessFrame,
  PROTOCOL_VERSION,
  type ProcessFrame,
  type TransportEvent,
} from "../../packages/protocol/src/index.ts";
import { readJsonLines } from "../../packages/runtime-bun/src/index.ts";

test("external generated backend uses actual SDK command/storage/event; revoked saves are not replayed", async () => {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), "bunaway-template-")));
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const project = await createProject(resolve(root, "independent"));
    const install = Bun.spawn([process.execPath, "install"], {
      cwd: project,
      stdout: "ignore",
      stderr: "pipe",
    });
    const installErrors = new Response(install.stderr).text();
    expect(await install.exited, await installErrors).toBe(0);
    const assets = resolve(root, "assets");
    const definition = await validateProject(project);
    await bundleAssets(definition, assets);
    const backend = resolve(assets, "backend.js");
    const processChild = Bun.spawn([process.execPath, "--no-env-file", "--no-install", backend], {
      cwd: root,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    child = processChild;
    const timeout = setTimeout(() => processChild.kill(), 12000);
    const errors = new Response(processChild.stderr).text();
    const frames = readJsonLines(processChild.stdout)[Symbol.asyncIterator]();
    const send = (body: Record<string, unknown>) =>
      processChild.stdin.write(
        `${JSON.stringify({
          ...body,
          ipc: PROTOCOL_VERSION,
          runtime: { id: "template", generation: "fresh" },
        })}\n`,
      );
    const next = async () => {
      const line = await frames.next();
      if (line.done) throw new Error("Unexpected EOF");
      return parseProcessFrame(line.value);
    };
    try {
      send({
        kind: "boot",
        payload: {
          entrypoint: backend,
          buildId: "template",
          backendContext: "backend-test",
          policy: definition.policy,
        },
      });
      expect((await next()).kind).toBe("hello");
      send({
        kind: "hello",
        payload: { kind: "hello", protocol: PROTOCOL_VERSION, features: [], buildId: "host" },
      });
      expect((await next()).kind).toBe("ready");
      const receivers = new Map<string, (event: TransportEvent) => void>();
      const completedWrites: string[] = [];
      let stored = "";
      let held: Extract<ProcessFrame, { kind: "host-request" }> | undefined;
      let holdReached: (() => void) | undefined;
      const hold = new Promise<void>((resolveHold) => {
        holdReached = resolveHold;
      });
      const reading = (async () => {
        for (;;) {
          const line = await frames.next();
          if (line.done) break;
          const frame = parseProcessFrame(line.value);
          if (frame.kind === "web")
            receivers.get(frame.context)?.({
              kind: "message",
              text: JSON.stringify(frame.payload),
            });
          if (frame.kind === "host-request") {
            expect(frame.context).toMatch(/^ctx-/);
            const call = parseHostCall(
              JSON.stringify({ operation: frame.operation, payload: frame.payload }),
            );
            if (call.operation === "storage.writeText" && call.payload.text === "pending save") {
              held = frame;
              holdReached?.();
              continue;
            }
            if (call.operation === "storage.writeText") {
              expect(call.payload.scope).toBe("appData");
              expect(call.payload.path).toBe("messages/current.txt");
              stored = call.payload.text;
              completedWrites.push(stored);
            }
            send({
              kind: "host-response",
              context: frame.context,
              requestId: frame.requestId,
              payload: {
                kind: "result",
                payload: call.operation === "storage.readText" ? stored : null,
              },
            });
          }
        }
      })();
      const session = (context: string) => {
        send({ kind: "session-open", context, viewId: "main" });
        return createClient({
          hello: { kind: "hello", protocol: PROTOCOL_VERSION, features: [], buildId: "ui" },
          transport: {
            async send(text) {
              send({ kind: "web", context, payload: JSON.parse(text) });
            },
            subscribe(listener) {
              receivers.set(context, listener);
              return () => {
                receivers.delete(context);
              };
            },
            async close() {
              send({ kind: "revoke", context });
              receivers.delete(context);
            },
          },
        });
      };
      const first = session("ctx-first");
      await first.ready;
      const events: unknown[] = [];
      await first.listen(
        "message.saved",
        (event) => {
          events.push(event.payload);
        },
        { onError() {} },
      );
      expect(await first.invoke("message.save", "saved via SDK")).toBeNull();
      expect(await first.invoke("message.read", null)).toBe("saved via SDK");
      expect(events).toEqual(["saved via SDK"]);
      const pending = first.invoke("message.save", "pending save").catch((error: unknown) => error);
      await hold;
      await first.close();
      expect(await pending).toBeInstanceOf(Error);
      const second = session("ctx-second");
      await second.ready;
      if (!held) throw new Error("Missing held request.");
      send({
        kind: "host-response",
        context: held.context,
        requestId: held.requestId,
        payload: { kind: "result", payload: null },
      });
      expect(await second.invoke("message.read", null)).toBe("saved via SDK");
      expect(completedWrites).toEqual(["saved via SDK"]);
      expect(events).toEqual(["saved via SDK"]);
      await second.close();
      send({ kind: "shutdown" });
      processChild.stdin.end();
      expect(await processChild.exited).toBe(0);
      await reading;
      expect(await errors).toBe("");
    } finally {
      clearTimeout(timeout);
      processChild.kill();
      await processChild.exited;
    }
  } finally {
    if (child) {
      child.kill();
      await child.exited;
    }
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
