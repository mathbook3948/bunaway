import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import type { HostContext } from "@bunaway/protocol";
import { Channel, type Packet } from "#native/windows/bun/channel";
import { bundleIOPluginFixture } from "../fixtures/native-worker.ts";

test("I/O Worker awaits parsing before authorization and discards cancelled parsers", async () => {
  const assets = resolve(
    import.meta.dir,
    "../../build",
    `async-io-${crypto.randomUUID()}`,
  );
  const plugin = {
    name: "async",
    version: "development",
    execution: "io" as const,
    native: {
      operations: [
        {
          name: "async.run",
        },
      ],
    },
  };
  const slots = {
    started: 0,
    released: 1,
    executions: 2,
    settled: 3,
  };
  await bundleIOPluginFixture(
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
    const plugin = defineNativePlugin({name:"async",operations:{run:{
      input:z.string().transform(async value => {
        if (value.startsWith("blocked")) {
          Atomics.add(state,slots.started,1);
          while (Atomics.load(state,slots.released) === 0) await Bun.sleep(1);
          Atomics.add(state,slots.settled,1);
          if (value === "blocked-error") throw new Error("late parser failure");
        }
        return value;
      }),
      output:z.string().transform(async value => {
        await Bun.sleep(1);
        if (value === "output-error") throw new Error("private output failure");
        return value + "!";
      }),
    }},platforms:{windows:{execution:"io",create:()=>({
      execute(_name,input) { Atomics.add(state,slots.executions,1); return input; }, dispose(){},
    })}}});
    export const pluginImports = {async:{operations:async()=>({createOperations:plugin.definition.nativePlatforms.windows.create})}};
  `,
  );
  const state = new Int32Array(
    new SharedArrayBuffer(
      Object.keys(slots).length * Int32Array.BYTES_PER_ELEMENT,
    ),
  );
  const runtime = {
    id: "async-io",
    generation: "1",
  };
  const context = "backend" as HostContext;
  const worker = new Worker(
    pathToFileURL(resolve(assets, "host-operations.js")),
    {
      workerData: {
        runtime,
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
  const exited = new Promise<number>((resolve) => worker.once("exit", resolve));
  worker.on("error", (error) => {
    failure = error;
  });
  const packets: Packet[] = [];
  const channel = new Channel(
    worker,
    runtime,
    "main-io",
    (packet) => {
      packets.push(packet);
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
        throw new Error("I/O parser test timed out");
      }
      await Bun.sleep(1);
    }
  };
  const operation = (id: string, payload: string) =>
    channel.send({
      kind: "operation",
      requestId: id,
      context,
      source: "backend",
      call: {
        operation: "async.run",
        payload,
      },
    });
  try {
    await waitFor(() => packets.some((p) => p.kind === "ready"));
    for (const [index, kind] of [
      "cancel",
      "cancel-context",
    ].entries()) {
      Atomics.store(state, slots.released, 0);
      const id = `cancel-${index}`;
      await operation(id, index === 0 ? "blocked" : "blocked-error");
      await waitFor(() => Atomics.load(state, slots.started) === index + 1);
      expect(packets.filter((p) => p.kind === "prepare")).toHaveLength(0);
      await channel.send(
        kind === "cancel"
          ? {
              kind: "cancel",
              context,
              requestId: id,
            }
          : {
              kind: "cancel-context",
              context,
            },
      );
      Atomics.store(state, slots.released, 1);
      await waitFor(() => Atomics.load(state, slots.settled) === index + 1);
      await channel.send({
        kind: "grant",
        requestId: id,
        context,
        allowed: true,
      });
    }
    expect(Atomics.load(state, slots.executions)).toBe(0);
    for (const [index, payload] of [
      "output-error",
      "ok",
    ].entries()) {
      const id = `run-${index}`;
      await operation(id, payload);
      await waitFor(() =>
        packets.some((p) => p.kind === "prepare" && p.requestId === id),
      );
      expect(Atomics.load(state, slots.executions)).toBe(index);
      // A duplicate grant during asynchronous output parsing must never execute twice.
      await Promise.all(
        [
          0,
          1,
        ].map(() =>
          channel.send({
            kind: "grant",
            requestId: id,
            context,
            allowed: true,
          }),
        ),
      );
      await waitFor(() =>
        packets.some((p) => p.kind === "host-response" && p.requestId === id),
      );
      const response = packets.find(
        (p) => p.kind === "host-response" && p.requestId === id,
      );
      expect(response).toMatchObject({
        kind: "host-response",
        response:
          index === 0
            ? {
                kind: "error",
                error: {
                  code: "INTERNAL",
                },
              }
            : {
                kind: "result",
                payload: "ok!",
              },
      });
    }
    expect(Atomics.load(state, slots.executions)).toBe(2);
    expect(packets.filter((p) => p.kind === "prepare")).toHaveLength(2);
    expect(packets.filter((p) => p.kind === "host-response")).toHaveLength(2);
    await channel.send({
      kind: "shutdown",
    });
    expect(await exited).toBe(0);
    expect(packets.some((p) => p.kind === "cleaned")).toBe(true);
  } finally {
    channel.close();
    await worker.terminate();
  }
}, 15000);
