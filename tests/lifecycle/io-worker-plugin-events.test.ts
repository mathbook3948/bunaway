import { expect, setDefaultTimeout, test } from "bun:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { DEFAULT_MAX_PENDING, type HostContext } from "@bunaway/protocol";
import {
  Channel,
  type Packet,
  validatePacket,
} from "#native/windows/bun/channel";
import { deadline, waitFor as poll } from "../fixtures/deadlines.ts";
import { bundleIOPluginFixture } from "../fixtures/native-worker.ts";

setDefaultTimeout(deadline("build"));

const context = "backend" as HostContext;
const runtime = {
  id: "io-plugin-events",
  generation: "1",
};
const operations = [
  "probe.emit",
  "probe.burst",
  "probe.start",
];

type PluginEvent = Extract<
  Packet,
  {
    kind: "plugin-event";
  }
>;

/**
 * Starts the real I/O Worker with a fixture plugin that raises events through `environment.events`
 * and plays the main thread: it answers the authorization handshake and records what the Worker
 * sends. `holdEvents` keeps plugin events unacknowledged, like a UI thread that is slow to accept.
 */
async function startWorker() {
  const assets = resolve(
    import.meta.dir,
    "../../build",
    `plugin-events-${crypto.randomUUID()}`,
  );
  const plugin = {
    name: "probe",
    version: "development",
    thread: "worker" as const,
    native: {
      operations: operations.map((name) => ({
        name,
      })),
    },
  };
  await bundleIOPluginFixture(
    assets,
    [
      plugin,
    ],
    `
    import { defineNativePlugin } from ${JSON.stringify(resolve(import.meta.dir, "../../packages/plugin-sdk/src/index.ts"))};
    import { z } from "zod";
    const definitions = {
      emit: {
        input: z.object({
          event: z.string(),
          payload: z.any(),
          // Builds the payload inside the Worker, since a host call itself is capped at the same size.
          size: z.number().optional(),
          requiredOperation: z.string().optional(),
        }),
        output: z.null(),
      },
      burst: { input: z.object({ count: z.number() }), output: z.null() },
      start: { input: z.null(), output: z.null() },
    };
    const create = (environment) => {
      let ticks = 0;
      return {
        execute(name, input) {
          if (name === "probe.emit") {
            environment.events.emit(
              input.event,
              input.size === undefined ? input.payload : "x".repeat(input.size),
              input.requiredOperation,
            );
          } else if (name === "probe.burst") {
            for (let index = 0; index < input.count; index++) {
              environment.events.emit("probe.tick", index);
            }
          } else {
            // Not cleared on dispose: emits after shutdown began must be dropped, not fail the Worker.
            setInterval(() => environment.events.emit("probe.tick", ticks++), 0).unref();
          }
          return null;
        },
        dispose() {},
      };
    };
    const plugin = defineNativePlugin({name:"probe", operations:definitions,platforms:{windows:{thread:"worker",create}}});
    export const pluginImports = {probe:{operations:async()=>({createOperations:plugin._definition.nativePlatforms.windows.create})}};
  `,
  );
  const worker = new Worker(
    pathToFileURL(resolve(assets, "host-operations.js")),
    {
      workerData: {
        runtime,
        assets,
        dataRoot: assets,
        policy: {
          version: 1,
          views: [],
          backend: {
            permissions: operations,
          },
        },
        plugins: [
          plugin,
        ],
      },
    },
  );
  let failure: unknown;
  const exited = new Promise<number>((resolveExit) =>
    worker.once("exit", resolveExit),
  );
  worker.on("error", (error) => {
    failure = error;
  });
  const packets: Packet[] = [];
  const hold = {
    release: undefined as (() => void) | undefined,
    gate: undefined as Promise<void> | undefined,
  };
  const channel = new Channel(
    worker,
    runtime,
    "main-io",
    (packet) => {
      packets.push(packet);
      return packet.kind === "plugin-event" ? hold.gate : undefined;
    },
    (error) => {
      failure = error;
    },
  );
  const waitFor = (predicate: () => boolean, what: string) =>
    poll(predicate, {
      deadline: "inProcess",
      what,
      intervalMs: 1,
      failed: () => failure,
    });
  const events = () =>
    packets.filter(
      (packet): packet is PluginEvent => packet.kind === "plugin-event",
    );
  return {
    packets,
    events,
    waitFor,
    exited,
    channel,
    failure: () => failure,
    /** Keep plugin events unacknowledged until `releaseEvents`. */
    holdEvents() {
      hold.gate = new Promise<void>((resolveGate) => {
        hold.release = resolveGate;
      });
    },
    releaseEvents() {
      hold.release?.();
      hold.gate = undefined;
    },
    /** Run one operation through the authorization handshake and return its host response. */
    async run(id: string, operation: string, payload: unknown) {
      await channel.send({
        kind: "operation",
        requestId: id,
        context,
        source: "backend",
        call: {
          operation,
          payload: payload as never,
        },
      });
      await waitFor(
        () =>
          packets.some(
            (p) => p.kind === "authorize-input" && p.requestId === id,
          ),
        "input authorization request",
      );
      await channel.send({
        kind: "input-authorized",
        requestId: id,
        context,
        allowed: true,
      });
      // Input that fails its schema is answered without an execution request.
      await waitFor(
        () =>
          packets.some(
            (p) =>
              (p.kind === "prepare" || p.kind === "host-response") &&
              p.requestId === id,
          ),
        "execution authorization request",
      );
      if (
        packets.some((p) => p.kind === "host-response" && p.requestId === id)
      ) {
        return packets.find(
          (p) => p.kind === "host-response" && p.requestId === id,
        );
      }
      await channel.send({
        kind: "grant",
        requestId: id,
        context,
        allowed: true,
      });
      await waitFor(
        () =>
          packets.some((p) => p.kind === "host-response" && p.requestId === id),
        "host response",
      );
      return packets.find(
        (p) => p.kind === "host-response" && p.requestId === id,
      );
    },
    async stop() {
      channel.close();
      await worker.terminate();
    },
  };
}

test("an I/O Worker plugin event reaches the main thread in order with its required operation", async () => {
  const host = await startWorker();
  try {
    await host.waitFor(
      () => host.packets.some((p) => p.kind === "ready"),
      "ready",
    );
    for (const [index, requiredOperation] of [
      undefined,
      "probe.emit",
      undefined,
    ].entries()) {
      expect(
        await host.run(`emit-${index}`, "probe.emit", {
          event: "probe.changed",
          payload: {
            index,
          },
          // A host call payload is JSON, so an absent operation is an absent key.
          ...(requiredOperation === undefined
            ? {}
            : {
                requiredOperation,
              }),
        }),
      ).toMatchObject({
        response: {
          kind: "result",
        },
      });
    }
    await host.waitFor(() => host.events().length === 3, "three plugin events");
    expect(host.events()).toEqual([
      {
        kind: "plugin-event",
        event: "probe.changed",
        payload: {
          index: 0,
        },
        requiredOperation: null,
        dropped: 0,
      },
      {
        kind: "plugin-event",
        event: "probe.changed",
        payload: {
          index: 1,
        },
        requiredOperation: "probe.emit",
        dropped: 0,
      },
      {
        kind: "plugin-event",
        event: "probe.changed",
        payload: {
          index: 2,
        },
        requiredOperation: null,
        dropped: 0,
      },
    ]);
  } finally {
    await host.stop();
  }
});

test("a plugin cannot emit outside its own event namespace or with an invalid payload", async () => {
  const host = await startWorker();
  try {
    await host.waitFor(
      () => host.packets.some((p) => p.kind === "ready"),
      "ready",
    );
    for (const [id, input] of [
      [
        "other-plugin",
        {
          event: "storage.changed",
          payload: null,
        },
      ],
      [
        "no-prefix",
        {
          event: "changed",
          payload: null,
        },
      ],
      [
        "bad-name",
        {
          event: "probe.has space",
          payload: null,
        },
      ],
      [
        "bad-operation",
        {
          event: "probe.changed",
          payload: null,
          requiredOperation: "has space",
        },
      ],
      [
        "too-large",
        {
          event: "probe.changed",
          payload: null,
          size: 1_048_577,
        },
      ],
    ] as const) {
      expect(await host.run(id, "probe.emit", input)).toMatchObject({
        response: {
          kind: "error",
          error: {
            code: "INVALID_ARGUMENT",
          },
        },
      });
    }
    expect(host.events()).toHaveLength(0);
    expect(host.failure()).toBeUndefined();
  } finally {
    await host.stop();
  }
});

test("a slow receiver drops new plugin events, counts them and keeps host responses flowing", async () => {
  const host = await startWorker();
  try {
    await host.waitFor(
      () => host.packets.some((p) => p.kind === "ready"),
      "ready",
    );
    host.holdEvents();
    const surplus = 10;
    // The burst runs in one call, so no event is acknowledged before the lane fills.
    expect(
      await host.run("burst", "probe.burst", {
        count: DEFAULT_MAX_PENDING + surplus,
      }),
    ).toMatchObject({
      response: {
        kind: "result",
      },
    });
    await host.waitFor(
      () => host.events().length === DEFAULT_MAX_PENDING,
      "a full event lane",
    );
    // Requests still complete while every event slot is held.
    expect(
      await host.run("while-held", "probe.emit", {
        event: "probe.changed",
        payload: null,
      }),
    ).toMatchObject({
      response: {
        kind: "result",
      },
    });
    expect(host.events()).toHaveLength(DEFAULT_MAX_PENDING);
    expect(host.events().map((event) => event.payload)).toEqual(
      Array.from(
        {
          length: DEFAULT_MAX_PENDING,
        },
        (_, index) => index,
      ),
    );
    host.releaseEvents();
    // The next accepted event reports how many were lost before it.
    await host.run("after-release", "probe.emit", {
      event: "probe.changed",
      payload: "after",
    });
    await host.waitFor(
      () => host.events().some((event) => event.payload === "after"),
      "the event after the drop",
    );
    const counted = host
      .events()
      .reduce((total, event) => total + event.dropped, 0);
    expect(counted).toBe(surplus + 1);
    expect(host.failure()).toBeUndefined();
  } finally {
    await host.stop();
  }
});

test("shutdown with a plugin still emitting cleans up without failing the Worker", async () => {
  const host = await startWorker();
  try {
    await host.waitFor(
      () => host.packets.some((p) => p.kind === "ready"),
      "ready",
    );
    await host.run("start", "probe.start", null);
    await host.waitFor(() => host.events().length > 0, "a timer event");
    await host.channel.send({
      kind: "shutdown",
    });
    expect(await host.exited).toBe(0);
    expect(host.packets.some((p) => p.kind === "cleaned")).toBe(true);
    expect(host.failure()).toBeUndefined();
  } finally {
    await host.stop();
  }
});

test("plugin event packets are accepted only between the I/O Worker and the UI path", () => {
  const packet: Packet = {
    kind: "plugin-event",
    event: "probe.changed",
    payload: {
      value: 1,
    },
    requiredOperation: null,
    dropped: 0,
  };
  for (const side of [
    "main-io",
    "ui",
  ] as const) {
    expect(validatePacket(packet, side)).toEqual(packet);
  }
  for (const side of [
    "main",
    "io",
  ] as const) {
    expect(() => validatePacket(packet, side)).toThrow();
  }
  for (const invalid of [
    {
      ...packet,
      event: "has space",
    },
    {
      ...packet,
      requiredOperation: 1,
    },
    {
      ...packet,
      dropped: -1,
    },
    {
      ...packet,
      dropped: 1.5,
    },
    {
      kind: packet.kind,
      event: packet.event,
      payload: packet.payload,
      requiredOperation: null,
    },
    {
      ...packet,
      extra: true,
    },
  ]) {
    expect(() => validatePacket(invalid, "main-io")).toThrow();
  }
});
