import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { type CommandContext, command } from "@bunaway/backend";
import { bindHostAPI } from "@bunaway/core";
import power from "@bunaway/plugin-power";
import {
  type HostContext,
  type HostResponse,
  NativeRegistry,
} from "@bunaway/protocol";
import { Channel, type UIConfig } from "#native/windows/bun/channel";
import { bundleUIPluginFixture } from "../fixtures/native-worker.ts";

const WORKER_TIMEOUT_MS = 10000;
const MAX_PACKET_TRACE = 16;

/**
 * Run the compiled public power API against the real UI worker.
 * The UI worker decides operation permission from its startup policy, so each grant set needs its own worker.
 */
async function withPowerUI(
  permissions: string[],
  exercise: (context: CommandContext) => Promise<void>,
) {
  const root = await mkdtemp(resolve(tmpdir(), "bunaway-power-ui-"));
  const runtime = {
    id: "power-ui",
    generation: crypto.randomUUID(),
  };
  const backendContext = crypto.randomUUID() as HostContext;
  const registration = {
    name: power._definition.name,
    version: power._definition.version,
    native: power._definition.native,
  };
  const registry = new NativeRegistry([
    registration,
  ]);
  const config: UIConfig = {
    runtime,
    policy: {
      version: 1,
      views: [],
      backend: {
        permissions,
      },
    },
    backendContext,
    windows: [],
    // Without windows or a tray the UI worker would commit app shutdown on its first loop iteration and deny every operation.
    desktop: {
      closeBehavior: "keep-alive",
    },
    assets: root,
    dataRoot: root,
    loader: "",
    plugins: [
      registration,
    ],
  };
  const pending = new Map<
    string,
    {
      resolve(response: HostResponse): void;
      reject(error: unknown): void;
    }
  >();
  const packetTrace: string[] = [];
  let worker: Worker | undefined;
  let channel: Channel | undefined;
  let ready = false;
  let cleaned = false;
  let failure: unknown;
  const fail = (error: unknown) => {
    failure = error;
    for (const reply of pending.values()) {
      reply.reject(error);
    }
    pending.clear();
    // A failed receive callback also prevents send acknowledgements from arriving.
    channel?.close();
  };
  try {
    await bundleUIPluginFixture(
      root,
      [
        {
          ...registration,
          thread: "ui",
        },
      ],
      `import power from ${JSON.stringify(resolve(import.meta.dir, "../../plugins/power/dist/native/windows.js"))};
export const pluginImports = { power: { operations: async () => ({ createOperations: power._definition.nativePlatforms.windows.create }) } };`,
    );
    worker = new Worker(pathToFileURL(resolve(root, "ui.js")), {
      workerData: config,
    });
    const exited = new Promise<number>((done) => worker?.once("exit", done));
    worker.once("error", fail);
    worker.once("exit", (code) => {
      if (pending.size) {
        fail(new Error(`Power UI worker exited before replying: ${code}`));
      }
    });
    const connection = new Channel(
      worker,
      runtime,
      "main",
      (packet) => {
        packetTrace.push(packet.kind);
        if (packetTrace.length > MAX_PACKET_TRACE) {
          packetTrace.shift();
        }
        if (packet.kind === "ready") {
          ready = true;
        } else if (packet.kind === "prepare") {
          // The UI worker applies the operation policy after this host-level grant.
          connection.notify({
            kind: "grant",
            requestId: packet.requestId,
            context: packet.context,
            allowed: true,
          });
        } else if (packet.kind === "host-response") {
          const settle = pending.get(packet.requestId);
          pending.delete(packet.requestId);
          settle?.resolve(packet.response);
        } else if (packet.kind === "cleaned") {
          cleaned = true;
        } else if (packet.kind === "closing") {
          // Keep-alive means any closing packet is an unexpected early shutdown that would deny later operations.
          fail(
            new Error(
              `Power UI worker committed shutdown early: ${packet.reason}`,
            ),
          );
        } else if (packet.kind === "fatal") {
          fail(new Error(packet.error.message));
        }
      },
      fail,
    );
    channel = connection;
    const deadline = Date.now() + WORKER_TIMEOUT_MS;
    while (!ready) {
      if (failure) {
        throw failure;
      }
      if (Date.now() >= deadline) {
        throw new Error("Power UI worker startup timed out.");
      }
      await Bun.sleep(1);
    }
    const controller = new AbortController();
    await exercise({
      signal: controller.signal,
      host: bindHostAPI(
        backendContext,
        controller.signal,
        async (_context, call) => {
          if (failure) {
            throw failure;
          }
          const requestId = crypto.randomUUID();
          let timeout: ReturnType<typeof setTimeout> | undefined;
          const response = new Promise<HostResponse>((done, reject) => {
            pending.set(requestId, {
              resolve: done,
              reject,
            });
          });
          const timedOut = new Promise<never>((_done, reject) => {
            timeout = setTimeout(() => {
              const error = new Error(
                `Power UI worker ${call.operation} timed out. Packets: ${packetTrace.join(", ")}`,
              );
              fail(error);
              reject(error);
            }, WORKER_TIMEOUT_MS);
          });
          try {
            const sent = connection.send({
              kind: "operation",
              requestId,
              context: backendContext,
              source: "backend",
              call,
            });
            // Observe the reply immediately, even while its operation acknowledgement is pending.
            const exchange = Promise.all([
              sent,
              response,
            ]).then(([, reply]) => reply);
            return await Promise.race([
              exchange,
              timedOut,
            ]);
          } finally {
            clearTimeout(timeout);
            pending.delete(requestId);
          }
        },
        registry,
      ),
      state: {
        get: () => undefined,
        set() {},
        delete: () => false,
      },
      events: {
        async emit() {},
      },
    });
    await connection.send({
      kind: "shutdown",
    });
    expect(await exited).toBe(0);
    expect(cleaned).toBe(true);
    expect(failure).toBeUndefined();
    expect(pending.size).toBe(0);
  } catch (error) {
    // Host API errors are sanitized; retain the original fixture transport failure.
    throw failure ?? error;
  } finally {
    await worker?.terminate();
    channel?.close();
    await rm(root, {
      recursive: true,
      force: true,
    });
  }
}

test.skipIf(process.platform !== "win32")(
  "compiled public power API crosses the real UI worker and obeys operation grants",
  async () => {
    await withPowerUI(
      [
        "power.getStatus",
      ],
      async (context) => {
        await command({
          input: {
            const: null,
          },
          output: {
            const: null,
          },
          async handle() {
            expect((await power.getStatus()).source).toMatch(
              /^(ac|battery|unknown)$/,
            );
            // Node's asynchronous assertion keeps Worker authorization delivery live.
            await assert.rejects(
              power.startBlocker({
                type: "system",
                reason: "denied",
              }),
              {
                code: "PERMISSION_DENIED",
              },
            );
            return null;
          },
        }).run(null, context);
      },
    );
    await withPowerUI(
      power._definition.native.operations.map((operation) => operation.name),
      async (context) => {
        await command({
          input: {
            const: null,
          },
          output: {
            const: null,
          },
          async handle() {
            expect(await power.listBlockers()).toEqual([]);
            expect(await power.getIdleTime()).toBeGreaterThanOrEqual(0);
            expect([
              "active",
              "idle",
            ]).toContain(
              await power.getIdleState({
                thresholdSeconds: 1,
              }),
            );
            const first = await power.startBlocker({
              type: "system",
              reason: "public worker",
            });
            const second = await power.startBlocker({
              type: "system",
              reason: "public worker",
            });
            expect(first.id).not.toBe(second.id);
            expect(
              await power.isBlockerActive({
                id: first.id,
              }),
            ).toBe(true);
            expect(
              await power.stopBlocker({
                id: first.id,
              }),
            ).toBe(true);
            expect(
              await power.stopBlocker({
                id: first.id,
              }),
            ).toBe(false);
            expect(await power.listBlockers()).toEqual([
              second,
            ]);
            const display = await power.startBlocker({
              type: "display",
              reason: "display worker",
            });
            expect(
              await power.stopBlocker({
                id: display.id,
              }),
            ).toBe(true);
            // Leave the second owned request for the production worker's shutdown cleanup.
            return null;
          },
        }).run(null, context);
      },
    );
  },
  40000,
);
