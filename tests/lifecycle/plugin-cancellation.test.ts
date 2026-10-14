import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import {
  API_LIMITS,
  type HostContext,
  type HostResponse,
} from "@bunaway/protocol";
import { Channel } from "#native/windows/bun/channel";
import {
  bundleIOPluginFixture,
  bundleUIPluginFixture,
} from "../fixtures/native-worker.ts";

for (const [workerKind, phase] of [
  [
    "io",
    "input",
  ],
  [
    "io",
    "output",
  ],
  [
    "ui",
    "input",
  ],
  [
    "ui",
    "output",
  ],
  [
    "ui",
    "execution",
  ],
] as const) {
  test.skipIf(workerKind === "ui" && process.platform !== "win32")(
    `cancelled ${workerKind} ${phase} releases capacity and observes late failures`,
    async () => {
      const assets = resolve(
        import.meta.dir,
        "../../build",
        `output-io-${crypto.randomUUID()}`,
      );
      const plugin = {
        name: "output",
        version: "development",
        thread: workerKind === "io" ? ("worker" as const) : ("ui" as const),
        native: {
          operations: [
            {
              name: "output.run",
            },
          ],
        },
      };
      const slots = {
        started: 0,
        released: 1,
        settled: 2,
        executions: 3,
      };
      const bundle =
        workerKind === "ui" ? bundleUIPluginFixture : bundleIOPluginFixture;
      await bundle(
        assets,
        [
          plugin,
        ],
        `
    import { workerData } from "node:worker_threads";
    import { defineNativePlugin } from ${JSON.stringify(resolve(import.meta.dir, "../../packages/plugin-sdk/src/index.ts"))};
    import { z } from "zod";
    const state = new Int32Array(workerData.state);
    const slots = ${JSON.stringify(slots)};
    const phase = ${JSON.stringify(phase)};
    const pause = async value => {
        Atomics.add(state,slots.started,1);
        if (value === "never") await new Promise(() => {});
        if (value.startsWith("late-")) {
          while (Atomics.load(state,slots.released) === 0) await Bun.sleep(1);
          Atomics.add(state,slots.settled,1);
          if (value === "late-error") throw new Error("late output failure");
        }
        return value;
      };
    const plugin = defineNativePlugin({name:"output",operations:{run:{
      input:phase === "input" ? z.string().transform(pause) : z.string(),
      output:phase === "output" ? z.string().transform(pause) : z.string(),
    }},platforms:{windows:{thread:${JSON.stringify(workerKind === "io" ? "worker" : "ui")},create:()=>({
      execute(_name,input) { Atomics.add(state,slots.executions,1); return input; },
      ...( ${JSON.stringify(workerKind)} === "ui" ? {async executeUI(_name,input) { Atomics.add(state,slots.executions,1); return phase === "execution" ? pause(input) : input; }} : {}),
      dispose(){},
    })}}});
    export const pluginImports = {output:{operations:async()=>({createOperations:plugin._definition.nativePlatforms.windows.create})}};
  `,
      );
      const state = new Int32Array(
        new SharedArrayBuffer(
          Object.keys(slots).length * Int32Array.BYTES_PER_ELEMENT,
        ),
      );
      const runtime = {
        id: "output-io",
        generation: "1",
      };
      const context = "backend" as HostContext;
      const worker = new Worker(
        pathToFileURL(
          resolve(assets, workerKind === "ui" ? "ui.js" : "host-operations.js"),
        ),
        {
          workerData: {
            runtime,
            backendContext: context,
            windows: [],
            desktop: {
              closeBehavior: "keep-alive",
            },
            loader: "",
            policy: {
              version: 1,
              views: [],
              backend: {
                permissions: [
                  "output.run",
                ],
              },
            },
            assets,
            dataRoot: assets,
            plugins: [
              plugin,
            ],
            state: state.buffer,
          },
        },
      );
      let failure: unknown;
      let ready = false;
      let cleaned = false;
      const responses = new Map<string, HostResponse>();
      const exited = new Promise<number>((resolve) =>
        worker.once("exit", resolve),
      );
      worker.on("error", (error) => {
        failure = error;
      });
      const channel = new Channel(
        worker,
        runtime,
        workerKind === "ui" ? "main" : "main-io",
        (packet) => {
          if (packet.kind === "ready") {
            ready = true;
          } else if (packet.kind === "cleaned") {
            cleaned = true;
          } else if (
            packet.kind === "authorize-input" ||
            packet.kind === "prepare"
          ) {
            channel.notify({
              kind:
                packet.kind === "authorize-input"
                  ? "input-authorized"
                  : "grant",
              context: packet.context,
              requestId: packet.requestId,
              allowed: true,
            });
          } else if (packet.kind === "host-response") {
            responses.set(packet.requestId, packet.response);
          } else if (packet.kind !== "diagnostic") {
            throw new Error("Unexpected Worker response");
          }
        },
        (error) => {
          failure = error;
        },
      );
      const waitFor = async (predicate: () => boolean) => {
        const deadline = Date.now() + 5000;
        while (!predicate()) {
          if (failure) {
            throw failure;
          }
          if (Date.now() > deadline) {
            throw new Error("I/O output test timed out");
          }
          await Bun.sleep(1);
        }
      };
      let executions = 0;
      const operation = async (requestId: string, payload: string) => {
        await channel.send({
          kind: "operation",
          requestId,
          context,
          source: "backend",
          call: {
            operation: "output.run",
            payload,
          },
        });
        executions++;
        await waitFor(() => Atomics.load(state, slots.started) === executions);
      };
      try {
        await waitFor(() => ready);
        // Keep the parsers unresolved: capacity must return on acceptance, not on output settlement.
        for (let index = 0; index < API_LIMITS.maxPending; index++) {
          const requestId = `never-${index}`;
          await operation(requestId, "never");
          await channel.send(
            index % 2 === 0
              ? {
                  kind: "cancel",
                  context,
                  requestId,
                }
              : {
                  kind: "cancel-context",
                  context,
                },
          );
        }
        expect(channel.canSend()).toBe(true);
        await operation("healthy", "ok");
        await waitFor(() => responses.has("healthy"));
        expect(responses.get("healthy")).toEqual({
          kind: "result",
          payload: "ok",
        });
        for (const [index, payload] of [
          "late-success",
          "late-error",
        ].entries()) {
          Atomics.store(state, slots.released, 0);
          await operation(payload, payload);
          await channel.send({
            kind: "cancel",
            context,
            requestId: payload,
          });
          await channel.drain();
          expect(channel.canSend()).toBe(true);
          // Duplicate grants after cancellation cannot repeat the native side effect.
          await channel.send({
            kind: "grant",
            context,
            requestId: payload,
            allowed: true,
          });
          Atomics.store(state, slots.released, 1);
          await waitFor(() => Atomics.load(state, slots.settled) === index + 1);
        }
        await operation("after-late", "ok");
        await waitFor(() => responses.has("after-late"));
        expect(responses.get("after-late")).toEqual({
          kind: "result",
          payload: "ok",
        });
        expect([
          ...responses.keys(),
        ]).toEqual([
          "healthy",
          "after-late",
        ]);
        expect(Atomics.load(state, slots.executions)).toBe(
          phase === "input" ? 2 : API_LIMITS.maxPending + 4,
        );
        await channel.drain();
        expect(channel.canSend(API_LIMITS.maxPending)).toBe(true);
        await operation("shutdown-pending", "never");
        await channel.send({
          kind: "shutdown",
        });
        expect(await exited).toBe(0);
        expect(cleaned).toBe(true);
        expect(failure).toBeUndefined();
      } finally {
        channel.close();
        await worker.terminate();
      }
    },
    15000,
  );
}
