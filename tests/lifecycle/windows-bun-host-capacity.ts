import { mock } from "bun:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import type { Packet, UIConfig } from "../../native/windows/bun/channel.ts";
import type {
  AppDefinition,
  CoreServices,
} from "../../packages/core/src/index.ts";
import {
  API_LIMITS,
  BunawayError,
  type RuntimeIdentity,
} from "../../packages/protocol/src/index.ts";
import { writePluginFixture } from "../fixtures/native-worker.ts";

// Isolated subprocess: exercise the real entry/channel with independently delayed Worker acks.
type Envelope = {
  runtime: RuntimeIdentity;
  sequence: number;
  packet: Packet;
};
const workers: TestWorker[] = [];
/** Models a Worker whose operation and cancellation acknowledgements can be delayed independently. */
class TestWorker extends EventEmitter {
  private sequence = 0;
  readonly runtime: RuntimeIdentity;
  readonly held: Envelope[] = [];
  constructor(
    _path: URL,
    options: {
      workerData: {
        runtime: RuntimeIdentity;
      };
    },
  ) {
    super();
    this.runtime = options.workerData.runtime;
    workers.push(this);
    setTimeout(
      () =>
        this.packet({
          kind: "ready",
        }),
      0,
    );
  }
  packet(packet: Packet) {
    this.emit("message", {
      runtime: this.runtime,
      sequence: ++this.sequence,
      packet,
    });
  }
  /** Acknowledges only held messages of this kind and retains the others. */
  release(kind: Packet["kind"]) {
    for (const envelope of this.held.splice(0)) {
      if (envelope.packet.kind === kind) {
        this.emit("message", {
          runtime: this.runtime,
          ack: envelope.sequence,
        });
      } else {
        this.held.push(envelope);
      }
    }
  }
  postMessage(
    envelope:
      | Envelope
      | {
          ack: number;
        },
  ) {
    if ("ack" in envelope) {
      return;
    }
    if (
      envelope.packet.kind === "operation" ||
      envelope.packet.kind === "cancel"
    ) {
      this.held.push(envelope);
      return;
    }
    queueMicrotask(() => {
      this.emit("message", {
        runtime: this.runtime,
        ack: envelope.sequence,
      });
      if (envelope.packet.kind === "shutdown") {
        this.packet({
          kind: "cleaned",
        });
        setTimeout(() => this.emit("exit", 0), 0);
      }
    });
  }
}
mock.module("node:worker_threads", () => ({
  Worker: TestWorker,
}));
mock.module("../../native/windows/bun/job.ts", () => ({
  containAppProcess() {},
  activeDescendants: () => 0,
}));
let capture = (_services: CoreServices) => {};
const captured = new Promise<CoreServices>((done) => {
  capture = done;
});
mock.module("../../packages/core/src/index.ts", () => ({
  createCore: async (_app: AppDefinition, services: CoreServices) => {
    capture(services);
    return {
      async stop() {},
    };
  },
}));

const config: UIConfig = {
  runtime: {
    id: "capacity-test",
    generation: "1",
  },
  backendContext: "backend-test" as UIConfig["backendContext"],
  dataRoot: resolve(
    import.meta.dir,
    `../../build/windows-bun-capacity-${process.pid}`,
  ),
  policy: {
    version: 1,
    views: [],
    backend: {
      permissions: [],
    },
  },
  windows: [],
  assets: "",
  loader: "",
};
mock.module("bunaway:plugin-imports", () => ({
  pluginImports: {},
}));
config.assets = config.dataRoot;
await writePluginFixture(config.assets, [], "export const pluginImports = {};");
const { runWindowsApp } = await import("../../native/windows/bun/entry.ts");
const app = runWindowsApp(
  {
    commands: {},
    events: {},
  },
  config,
);
void app.catch(() => {}); // Await the failure in finally, including on the unfixed implementation.
const services = await captured;
const [ui, io] = workers;
assert(ui && io);
const call = {
  operation: "capabilities.get",
  payload: null,
} as const;
const request = () => {
  const controller = new AbortController();
  const result = services
    .callHost(config.backendContext, call, controller.signal)
    .catch((error: unknown) => error);
  return {
    controller,
    result,
  };
};
const busy = () =>
  assert.rejects(
    services.callHost(
      config.backendContext,
      call,
      new AbortController().signal,
    ),
    (error: unknown) => error instanceof BunawayError && error.code === "BUSY",
  );
try {
  // Capacity returns only after both Workers acknowledge a cancelled call.
  const pending = Array.from(
    {
      length: API_LIMITS.maxPending,
    },
    request,
  );
  const half = pending.splice(0, API_LIMITS.maxPending / 2);
  for (const request of half) {
    request.controller.abort();
  }
  for (const request of half) {
    const error = await request.result;
    assert(error instanceof BunawayError && error.code === "CANCELLED");
  }
  await busy(); // Unacknowledged operation messages still occupy the data lane.
  io.release("operation");
  await busy(); // Remaining calls and unacknowledged cancellations share the limit.
  ui.release("cancel");
  await busy(); // I/O acknowledgement is required even after the UI acknowledges.
  io.release("cancel");
  pending.push(
    ...Array.from(
      {
        length: half.length,
      },
      request,
    ),
  );
  await busy(); // Recovered capacity does not increase the outstanding-call limit.
  for (const request of pending) {
    request.controller.abort();
  }
  await Promise.all(pending.map((request) => request.result));
  io.release("operation");
  io.release("cancel");
  await busy(); // UI acknowledgement is also required when I/O acknowledges first.
  ui.release("cancel");
  const resumed = request();
  const operation = io.held[0]?.packet;
  assert(operation?.kind === "operation");
  io.release("operation");
  io.packet({
    kind: "host-response",
    context: operation.context,
    requestId: operation.requestId,
    response: {
      kind: "result",
      payload: null,
    },
  });
  assert.deepEqual(await resumed.result, {
    kind: "result",
    payload: null,
  });
} finally {
  ui.packet({
    kind: "closing",
  });
  await app;
}
console.log(
  "PASS Host capacity recovers after both Workers acknowledge cancellation",
);
