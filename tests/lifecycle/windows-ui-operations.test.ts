import { expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import {
  Channel,
  type Packet,
  type UIConfig,
} from "#native/windows/bun/channel";
import { API_LIMITS, MAX_MESSAGE_BYTES } from "@bunaway/protocol";
import { bundleUIPluginFixture } from "../fixtures/native-worker.ts";

const native = {
  operations: [
    {
      name: "ui-test.wait",
      input: {
        const: null,
      },
      output: {
        type: "string",
      },
      permission: "ui-test:execute",
    },
    {
      name: "ui-test.large",
      input: {
        const: null,
      },
      output: {
        type: "string",
      },
      permission: "ui-test:execute",
    },
    {
      name: "ui-test.ok",
      input: {
        const: null,
      },
      output: {
        type: "string",
      },
      permission: "ui-test:execute",
    },
  ],
  permissions: [
    {
      name: "ui-test:execute",
    },
  ],
} as const;

const timeoutMs = 10_000;
const nearLimitPayloadBytes = MAX_MESSAGE_BYTES - 16;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return {
    promise,
    resolve,
  };
}

async function waitFor(
  description: string,
  condition: () => boolean,
  failed: () => unknown,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const error = failed();
    if (error) {
      throw error;
    }
    if (condition()) {
      return;
    }
    await Bun.sleep(2);
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

async function waitForSlot(state: Int32Array, index: number) {
  await waitFor(
    `shared worker state ${index}`,
    () => Atomics.load(state, index) === 1,
    () => null,
  );
}

function config(dataRoot: string, permissions: string[]): UIConfig {
  return {
    runtime: {
      id: `ui-test-${crypto.randomUUID()}`,
      generation: "1",
    },
    policy: {
      version: 1,
      views: [],
      backend: {
        permissions,
      },
    },
    backendContext: "backend" as UIConfig["backendContext"],
    windows: [],
    assets: dataRoot,
    dataRoot,
    loader: "",
    plugins: [
      {
        name: "ui-test",
        version: "1",
        native,
      },
    ],
  };
}

/** Start the real UI worker with shared-memory controls for blocked operations. */
async function startWorker(permissions: string[]) {
  const dataRoot = resolve(
    import.meta.dir,
    `../../build/windows-ui-operations-${crypto.randomUUID()}`,
  );
  await mkdir(dataRoot, {
    recursive: true,
  });
  const state = new Int32Array(
    new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 4),
  );
  const runtime = config(dataRoot, permissions);
  await bundleUIPluginFixture(
    dataRoot,
    [
      {
        name: "ui-test",
        version: "1",
        native: native,
        execution: "ui",
        authorization: false,
      },
    ],
    `import { workerData } from "node:worker_threads";
const state = new Int32Array(workerData.state);
export const pluginImports = { 'ui-test': {
  operations: async () => ({ createOperations: () => ({
    execute(operation) {
      Atomics.add(state, 0, 1);
      if (operation === "ui-test.wait") {
        Atomics.store(state, 1, 1);
        Atomics.notify(state, 1);
        Atomics.wait(state, 2, 0, 10000);
        Atomics.store(state, 3, 1);
        return "finished";
      }
      if (operation === "ui-test.large") return "x".repeat(${nearLimitPayloadBytes});
      return "ok";
    },
    dispose() {},
  }) }),
}};
`,
  );

  const worker = new Worker(pathToFileURL(resolve(dataRoot, "ui.js")), {
    workerData: {
      ...runtime,
      state: state.buffer,
    },
  });
  const readyGate = deferred<void>();
  const readySeen = deferred<void>();
  const packets: Packet[] = [];
  const responses = new Map<
    string,
    Extract<
      Packet,
      {
        kind: "host-result" | "host-response";
      }
    >
  >();
  const prepares = new Map<
    string,
    Extract<
      Packet,
      {
        kind: "prepare";
      }
    >
  >();
  const diagnostics: Extract<
    Packet,
    {
      kind: "diagnostic";
    }
  >[] = [];
  const heldGrants = new Set<string>();
  let failure: unknown;
  let exitCode: number | undefined;
  const exited = new Promise<number>((resolveExit) =>
    worker.once("exit", (code) => {
      exitCode = code;
      resolveExit(code);
    }),
  );
  worker.once("error", (error) => (failure = error));
  let channel!: Channel;
  channel = new Channel(
    worker,
    runtime.runtime,
    "main",
    async (packet) => {
      packets.push(packet);
      if (packet.kind === "ready") {
        // Hold packet handling at startup until stop() releases the gate.
        readySeen.resolve();
        await readyGate.promise;
      } else if (packet.kind === "prepare") {
        prepares.set(packet.requestId, packet);
        if (!heldGrants.has(packet.requestId)) {
          channel.notify({
            kind: "grant",
            context: packet.context,
            requestId: packet.requestId,
            allowed: true,
          });
        }
      } else if (packet.kind === "host-response") {
        responses.set(packet.requestId, packet);
      } else if (packet.kind === "diagnostic") {
        diagnostics.push(packet);
      } else if (packet.kind === "fatal") {
        failure = new Error(packet.error.message);
      }
    },
    (error) => {
      failure = error;
      void worker.terminate();
    },
  );
  const timer = setTimeout(() => {
    failure = new Error("UI operation worker timed out.");
    void worker.terminate();
  }, timeoutMs);

  const waitForResponse = async (requestId: string) => {
    await waitFor(
      `response ${requestId}`,
      () => responses.has(requestId),
      () => failure,
    );
    const response = responses.get(requestId);
    if (!response) {
      throw new Error(`Missing response ${requestId}.`);
    }
    return response;
  };
  const sendOperation = (requestId: string, operation: string) =>
    channel.send({
      kind: "operation",
      context: runtime.backendContext,
      requestId,
      call: {
        operation,
        payload: null,
      },
      source: "backend",
    });
  const stop = async () => {
    await channel.send({
      kind: "shutdown",
    });
    readyGate.resolve();
    await waitFor(
      "cleaned packet",
      () => packets.some((packet) => packet.kind === "cleaned"),
      () => failure,
    );
    expect(await exited).toBe(0);
    expect(failure).toBeUndefined();
  };

  try {
    await Promise.race([
      readySeen.promise,
      waitFor(
        "ready packet",
        () => !!failure || exitCode !== undefined,
        () => null,
      ).then(() => {
        throw failure ?? new Error(`UI worker exited early (${exitCode}).`);
      }),
    ]);
  } catch (error) {
    clearTimeout(timer);
    channel.close();
    try {
      await worker.terminate();
    } finally {
      await rm(dataRoot, {
        recursive: true,
        force: true,
      });
    }
    throw error;
  }

  return {
    channel,
    diagnostics,
    heldGrants,
    packets,
    prepares,
    responses,
    runtime,
    sendOperation,
    state,
    stop,
    waitForResponse,
    failed: () => failure,
    async close() {
      clearTimeout(timer);
      readyGate.resolve();
      try {
        channel.close();
        await worker.terminate();
      } finally {
        await rm(dataRoot, {
          recursive: true,
          force: true,
        });
      }
    },
  };
}

test.skipIf(process.platform !== "win32")(
  "UI worker approves a full concurrent operation burst without consuming data capacity",
  async () => {
    const ui = await startWorker([
      "ui-test:execute",
    ]);
    const ids = Array.from(
      {
        length: API_LIMITS.maxPending,
      },
      (_, index) => `burst-${index}`,
    );
    const submitted = Promise.all(
      ids.map((id) => ui.sendOperation(id, "ui-test.ok")),
    );
    void submitted.catch(() => {});
    try {
      await waitFor(
        "all burst responses",
        () => ui.responses.size === ids.length,
        ui.failed,
      );
      await submitted;
      for (const id of ids) {
        expect((await ui.waitForResponse(id)).response).toEqual({
          kind: "result",
          payload: "ok",
        });
      }
      expect(Atomics.load(ui.state, 0)).toBe(ids.length);
      await ui.sendOperation("after-burst", "ui-test.ok");
      expect((await ui.waitForResponse("after-burst")).response).toEqual({
        kind: "result",
        payload: "ok",
      });
      await ui.stop();
    } finally {
      await ui.close();
      await submitted.catch(() => {});
    }
  },
  timeoutMs + 5_000,
);

test.skipIf(process.platform !== "win32")(
  "UI worker drops queued calls on cancellation and does not roll back an operation already started",
  async () => {
    const ui = await startWorker([
      "ui-test:execute",
    ]);
    try {
      for (const [requestId, cancellation] of [
        [
          "cancel-one",
          {
            kind: "cancel",
            context: ui.runtime.backendContext,
            requestId: "cancel-one",
          },
        ],
        [
          "cancel-context",
          {
            kind: "cancel-context",
            context: ui.runtime.backendContext,
          },
        ],
      ] as const) {
        ui.heldGrants.add(requestId);
        await ui.sendOperation(requestId, "ui-test.ok");
        await waitFor(
          `prepare ${requestId}`,
          () => ui.prepares.has(requestId),
          ui.failed,
        );
        await ui.channel.send(cancellation);
        await ui.channel.send({
          kind: "grant",
          context: ui.runtime.backendContext,
          requestId,
          allowed: true,
        });
        expect(Atomics.load(ui.state, 0)).toBe(0);
        expect(ui.responses.has(requestId)).toBe(false);
      }

      await ui.sendOperation("started", "ui-test.wait");
      // The shared slot confirms execute() entered before cancellation is sent.
      await waitForSlot(ui.state, 1);
      ui.channel.notify({
        kind: "cancel",
        context: ui.runtime.backendContext,
        requestId: "started",
      });
      Atomics.store(ui.state, 2, 1);
      Atomics.notify(ui.state, 2);
      await waitForSlot(ui.state, 3);
      expect((await ui.waitForResponse("started")).response).toEqual({
        kind: "result",
        payload: "finished",
      });
      expect(Atomics.load(ui.state, 0)).toBe(1);
      await ui.stop();
    } finally {
      await ui.close();
    }
  },
  timeoutMs + 5_000,
);

test.skipIf(process.platform !== "win32")(
  "UI worker bounds a near-limit response, stays healthy, and reports denied operations",
  async () => {
    const responseOverhead =
      Buffer.byteLength(
        JSON.stringify({
          kind: "result",
          payload: "",
        }),
      ) - 2;
    expect(nearLimitPayloadBytes + 2).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
    expect(nearLimitPayloadBytes + 2 + responseOverhead).toBeGreaterThan(
      MAX_MESSAGE_BYTES,
    );
    const ui = await startWorker([
      "ui-test:execute",
    ]);
    try {
      await ui.sendOperation("oversized", "ui-test.large");
      expect((await ui.waitForResponse("oversized")).response).toEqual({
        kind: "error",
        error: {
          code: "INTERNAL",
          message: "Host operation failed.",
        },
      });
      await ui.sendOperation("healthy", "ui-test.ok");
      expect((await ui.waitForResponse("healthy")).response).toEqual({
        kind: "result",
        payload: "ok",
      });
      expect(Atomics.load(ui.state, 0)).toBe(2);
      await ui.stop();
    } finally {
      await ui.close();
    }

    const denied = await startWorker([]);
    try {
      await denied.sendOperation("denied", "ui-test.ok");
      expect((await denied.waitForResponse("denied")).response).toEqual({
        kind: "error",
        error: {
          code: "PERMISSION_DENIED",
          message: "Host context or policy denied.",
        },
      });
      await waitFor(
        "host-request-denied diagnostic",
        () =>
          denied.diagnostics.some(
            (packet) => packet.event === "host-request-denied",
          ),
        denied.failed,
      );
      expect(Atomics.load(denied.state, 0)).toBe(0);
      await denied.stop();
    } finally {
      await denied.close();
    }
  },
  timeoutMs + 5_000,
);
