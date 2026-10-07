import assert from "node:assert/strict";
import { parentPort, workerData } from "node:worker_threads";
import {
  API_LIMITS,
  BunawayError,
  type HostCall,
  type HostContext,
  type HostResponse,
  type NativeRegistration,
  type RuntimeIdentity,
  serializeHostResponse,
} from "../../../packages/protocol/src/index.ts";
import { Channel, type Packet } from "./channel.ts";
import { disposeAll, operations } from "./plugins.ts";

assert(parentPort);
const config = workerData as {
  runtime: RuntimeIdentity;
  dataRoot: string;
  plugins: NativeRegistration[];
};
const adapters = await operations(config.plugins, config.dataRoot, "io");
const queue = new Map<string, { context: HostContext; call: HostCall; source: string }>();
let active: string | undefined;
let stopping = false;
const channel = new Channel(parentPort, config.runtime, "io", receive, (error) => {
  throw error;
});
function startNext() {
  if (stopping || active) return;
  const next = queue.entries().next().value;
  if (!next) return;
  active = next[0];
  channel.notify({
    kind: "prepare",
    requestId: next[0],
    context: next[1].context,
    call: next[1].call,
  });
}
function execute(call: HostCall, source: string): HostResponse {
  try {
    const payload = adapters.execute(call.operation, call.payload, source);
    const response = { kind: "result", payload } as HostResponse;
    serializeHostResponse(response);
    return response;
  } catch (error) {
    return {
      kind: "error",
      error:
        error instanceof BunawayError
          ? { code: error.code, message: error.message }
          : { code: "INTERNAL", message: "Host operation failed." },
    };
  }
}
async function receive(packet: Packet) {
  if (packet.kind === "operation") {
    assert(
      !stopping && !queue.has(packet.requestId) && queue.size < API_LIMITS.maxPending,
      "Invalid I/O queue request",
    );
    queue.set(packet.requestId, {
      context: packet.context,
      call: packet.call,
      source: packet.source,
    });
    startNext();
  } else if (packet.kind === "grant") {
    const call = queue.get(packet.requestId);
    if (!call || active !== packet.requestId) return;
    assert(call.context === packet.context);
    queue.delete(packet.requestId);
    active = undefined;
    // No await or second queue between STA authorization and the checked-handle operation.
    const response = packet.allowed
      ? execute(call.call, call.source)
      : ({
          kind: "error",
          error: { code: "PERMISSION_DENIED", message: "Host context or policy denied." },
        } as HostResponse);
    channel.notify({
      kind: "host-response",
      context: call.context,
      requestId: packet.requestId,
      response,
    });
    startNext();
  } else if (packet.kind === "cancel") {
    queue.delete(packet.requestId);
    if (active === packet.requestId) active = undefined;
    startNext();
  } else if (packet.kind === "cancel-context") {
    for (const [id, call] of queue)
      if (call.context === packet.context) {
        queue.delete(id);
        if (active === id) active = undefined;
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
  } else throw new Error("Unexpected I/O packet");
}
async function finish() {
  try {
    await disposeAll([() => channel.drain(), () => adapters.dispose()]);
    await channel.send({ kind: "cleaned" });
  } finally {
    channel.close();
    parentPort?.close();
  }
}

channel.notify({ kind: "ready" });
