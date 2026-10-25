import assert from "node:assert/strict";
import { parentPort, workerData } from "node:worker_threads";
import {
  BunawayError,
  type HostCall,
  type HostContext,
  type HostResponse,
  type JsonValue,
  type NativeRegistration,
  type Policy,
  type RuntimeIdentity,
  resolveMaxPending,
} from "@bunaway/protocol";
import { Channel, type Packet } from "@bunaway/runtime-bun/worker-channel";
import { hostResponse } from "./host-response.ts";
import { loadPluginCatalog } from "./plugin-catalog.ts";
import { disposeAll, operations } from "./plugins.ts";

assert(parentPort);
const config = workerData as {
  app?: import("@bunaway/plugin").NativeEnvironment["app"];
  runtime: RuntimeIdentity;
  dataRoot: string;
  assets: string;
  plugins: NativeRegistration[];
  policy?: Policy;
};
const adapters = await operations(
  config.plugins,
  config.dataRoot,
  "worker",
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
    controller: AbortController;
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
const maxPending = resolveMaxPending(config.policy);
// Channel permits one full unacknowledged data lane and one full completion backlog.
const MAX_RESPONSE_OWNERS = 2 * maxPending;
const responses = new Map<string, NonNullable<ReturnType<typeof queue.get>>>();
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
  undefined,
  maxPending,
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
    const permissions =
      call.source === "backend"
        ? config.policy?.backend
        : config.policy?.views.find((view) => call.source === `view:${view.id}`)
            ?.host;
    const execute = await adapters.prepareIO(
      call.call.operation,
      call.call.payload,
      call.source,
      {
        requestId: id,
        // Main-thread grants remain authoritative. This snapshot is for adapter resource checks.
        permissions: permissions ?? {
          permissions: [],
        },
        signal: call.controller.signal,
        beforeExecute() {
          if (
            stopping ||
            call.controller.signal.aborted ||
            queue.get(id) !== call
          ) {
            throw new BunawayError({
              code: "CANCELLED",
              message: "Host call was cancelled.",
            });
          }
        },
      },
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

/** Release execution capacity while retaining cancellation ownership until response acceptance. */
function complete(
  id: string,
  call: NonNullable<ReturnType<typeof queue.get>>,
  response: HostResponse,
) {
  if (stopping || queue.get(id) !== call) {
    return;
  }
  queue.delete(id);
  assert(
    responses.size < MAX_RESPONSE_OWNERS,
    "I/O response owner limit reached",
  );
  responses.set(id, call);
  void (async () => {
    try {
      await channel.send({
        kind: "host-response",
        context: call.context,
        requestId: id,
        response,
      });
    } catch (error) {
      // A resource whose result could not be handed off still belongs to this call.
      call.controller.abort();
      throw error;
    } finally {
      if (responses.get(id) === call) {
        responses.delete(id);
      }
    }
  })().catch((error) => {
    throw error;
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

/** Queue a new operation behind the ones already waiting; the limits are checked before it is stored. */
function enqueueOperation(
  packet: Extract<
    Packet,
    {
      kind: "operation";
    }
  >,
) {
  assert(
    !stopping &&
      !queue.has(packet.requestId) &&
      !responses.has(packet.requestId) &&
      queue.size < maxPending,
    "Invalid I/O queue request",
  );
  // Map insertion order keeps operations FIFO while the UI authorizes one at a time.
  queue.set(packet.requestId, {
    context: packet.context,
    call: packet.call,
    source: packet.source,
    controller: new AbortController(),
    state: {
      phase: "input-authorization",
    },
  });
  startNext();
}

/** The UI answered the input authorization of the active call: deny it or start parsing. */
function acceptInputAuthorization(
  packet: Extract<
    Packet,
    {
      kind: "input-authorized";
    }
  >,
) {
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
}

/** The UI answered the execution authorization of the active call: deny it or start executing. */
function acceptExecutionGrant(
  packet: Extract<
    Packet,
    {
      kind: "grant";
    }
  >,
) {
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
}

/** Abort one queued call or one response awaiting acceptance, then let the next call start. */
function cancelRequest(
  packet: Extract<
    Packet,
    {
      kind: "cancel";
    }
  >,
) {
  const call = queue.get(packet.requestId) ?? responses.get(packet.requestId);
  if (call && call.context !== packet.context) {
    throw new Error("Invalid I/O cancellation context");
  }
  call?.controller.abort();
  queue.delete(packet.requestId);
  responses.delete(packet.requestId);
  if (active === packet.requestId) {
    active = undefined;
  }
  startNext();
}

/** Abort every queued call and pending response of a revoked context. */
function cancelContext(
  packet: Extract<
    Packet,
    {
      kind: "cancel-context";
    }
  >,
) {
  for (const [id, call] of queue) {
    if (call.context === packet.context) {
      call.controller.abort();
      queue.delete(id);
      if (active === id) {
        active = undefined;
      }
    }
  }
  for (const [id, call] of responses) {
    if (call.context === packet.context) {
      call.controller.abort();
      responses.delete(id);
    }
  }
  startNext();
}

/** Abort everything and schedule the final cleanup after the shutdown is acknowledged. */
function beginShutdown() {
  stopping = true;
  for (const call of queue.values()) {
    call.controller.abort();
  }
  for (const call of responses.values()) {
    call.controller.abort();
  }
  queue.clear();
  responses.clear();
  active = undefined;
  // Acknowledge shutdown acceptance before closing the port.
  setTimeout(() => {
    void finish().catch((error) => {
      throw error;
    });
  }, 0);
}

/** Apply I/O requests and control messages from the main-thread coordinator. */
function receive(packet: Packet) {
  switch (packet.kind) {
    case "operation":
      enqueueOperation(packet);
      return;
    case "input-authorized":
      acceptInputAuthorization(packet);
      return;
    case "grant":
      acceptExecutionGrant(packet);
      return;
    case "cancel":
      cancelRequest(packet);
      return;
    case "cancel-context":
      cancelContext(packet);
      return;
    case "shutdown":
      beginShutdown();
      return;
    default:
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
