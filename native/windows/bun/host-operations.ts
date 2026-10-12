import assert from "node:assert/strict";
import { parentPort, workerData } from "node:worker_threads";
import {
  API_LIMITS,
  type HostCall,
  type HostContext,
  type HostResponse,
  type JsonValue,
  type NativeRegistration,
  type RuntimeIdentity,
} from "@bunaway/protocol";
import { hostResponse } from "../../host-api/bun/host-response.ts";
import { loadPluginCatalog } from "../../host-api/bun/plugin-catalog.ts";
import { disposeAll, operations } from "../../host-api/bun/plugins.ts";
import { Channel, type Packet } from "./channel.ts";

assert(parentPort);
const config = workerData as {
  app?: import("@bunaway/plugin").NativeEnvironment["app"];
  runtime: RuntimeIdentity;
  dataRoot: string;
  assets: string;
  plugins: NativeRegistration[];
};
const adapters = await operations(
  config.plugins,
  config.dataRoot,
  "io",
  undefined,
  await loadPluginCatalog(config.assets),
  config.app,
);
const queue = new Map<
  string,
  {
    context: HostContext;
    call: HostCall;
    source: string;
    state:
      | {
          phase: "input-authorization" | "parsing" | "executing";
        }
      | {
          phase: "execution-authorization";
          execute: () => Promise<JsonValue>;
        };
  }
>();
let active: string | undefined;
let stopping = false;
const channel = new Channel(
  parentPort,
  config.runtime,
  "io",
  receive,
  (error) => {
    throw error;
  },
);
/** Ask the policy owner before running any plugin input callbacks. */
function startNext() {
  if (stopping || active) {
    return;
  }
  const next = queue.entries().next().value;
  if (!next) {
    return;
  }
  const [id, call] = next;
  active = id;
  channel.notify({
    kind: "authorize-input",
    requestId: id,
    context: call.context,
    call: call.call,
  });
}

/** Observe even late parser failures; cancelled calls never reach authorization or execution. */
async function prepare(
  id: string,
  call: NonNullable<ReturnType<typeof queue.get>>,
) {
  try {
    const execute = await adapters.prepare(
      call.call.operation,
      call.call.payload,
      call.source,
    );
    if (stopping || queue.get(id) !== call || active !== id) {
      return;
    }
    call.state = {
      phase: "execution-authorization",
      execute,
    };
    channel.notify({
      kind: "prepare",
      requestId: id,
      context: call.context,
      call: call.call,
    });
  } catch (error) {
    if (stopping || queue.get(id) !== call || active !== id) {
      return;
    }
    complete(
      id,
      call,
      hostResponse(() => {
        throw error;
      }),
    );
  }
}

/** Start native I/O synchronously and observe output settlement even after cancellation. */
async function executeCall(
  id: string,
  call: NonNullable<ReturnType<typeof queue.get>>,
  execute: () => Promise<JsonValue>,
) {
  let response: HostResponse;
  try {
    // The prepared function starts native I/O now, before its first await for output parsing.
    const payload = await execute();
    response = hostResponse(() => payload);
  } catch (error) {
    response = hostResponse(() => {
      throw error;
    });
  }
  complete(id, call, response);
}

/** Release this queue slot only if it still belongs to the completing call. */
function complete(
  id: string,
  call: NonNullable<ReturnType<typeof queue.get>>,
  response: HostResponse,
) {
  if (stopping || queue.get(id) !== call) {
    return;
  }
  queue.delete(id);
  channel.notify({
    kind: "host-response",
    context: call.context,
    requestId: id,
    response,
  });
  if (active === id) {
    active = undefined;
  }
  startNext();
}
function deniedResponse(): HostResponse {
  return {
    kind: "error",
    error: {
      code: "PERMISSION_DENIED",
      message: "Host context or policy denied.",
    },
  };
}

/** Apply I/O requests and control messages from the main-thread coordinator. */
function receive(packet: Packet) {
  if (packet.kind === "operation") {
    assert(
      !stopping &&
        !queue.has(packet.requestId) &&
        queue.size < API_LIMITS.maxPending,
      "Invalid I/O queue request",
    );
    // Map insertion order keeps operations FIFO while the UI authorizes one at a time.
    queue.set(packet.requestId, {
      context: packet.context,
      call: packet.call,
      source: packet.source,
      state: {
        phase: "input-authorization",
      },
    });
    startNext();
  } else if (packet.kind === "input-authorized") {
    const call = queue.get(packet.requestId);
    if (
      !call ||
      active !== packet.requestId ||
      call.state.phase !== "input-authorization"
    ) {
      return;
    }
    assert(call.context === packet.context);
    if (!packet.allowed) {
      complete(packet.requestId, call, deniedResponse());
      return;
    }
    call.state = {
      phase: "parsing",
    };
    // Acknowledge permission promptly; cancellation stays live while the parser awaits.
    void prepare(packet.requestId, call).catch((error) => {
      throw error;
    });
  } else if (packet.kind === "grant") {
    const call = queue.get(packet.requestId);
    if (
      !call ||
      active !== packet.requestId ||
      call.state.phase !== "execution-authorization"
    ) {
      return;
    }
    assert(call.context === packet.context);
    if (!packet.allowed) {
      complete(packet.requestId, call, deniedResponse());
      return;
    }
    const execute = call.state.execute;
    call.state = {
      phase: "executing",
    };
    // Accept the grant without holding channel capacity for asynchronous output parsing.
    void executeCall(packet.requestId, call, execute).catch((error) => {
      throw error;
    });
  } else if (packet.kind === "cancel") {
    queue.delete(packet.requestId);
    if (active === packet.requestId) {
      active = undefined;
    }
    startNext();
  } else if (packet.kind === "cancel-context") {
    for (const [id, call] of queue) {
      if (call.context === packet.context) {
        queue.delete(id);
        if (active === id) {
          active = undefined;
        }
      }
    }
    startNext();
  } else if (packet.kind === "shutdown") {
    stopping = true;
    queue.clear();
    active = undefined;
    // Acknowledge shutdown acceptance before closing the port.
    setTimeout(() => {
      void finish().catch((error) => {
        throw error;
      });
    }, 0);
  } else {
    throw new Error("Unexpected I/O packet");
  }
}
/** Drain channel messages, dispose adapters, then release both worker ports. */
async function finish() {
  try {
    await disposeAll([
      () => channel.drain(),
      () => adapters.dispose(),
    ]);
    await channel.send({
      kind: "cleaned",
    });
  } finally {
    channel.close();
    parentPort?.close();
  }
}

channel.notify({
  kind: "ready",
});
