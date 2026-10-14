import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { type CommandContext, command } from "@bunaway/backend";
import { bindHostAPI } from "@bunaway/core";
import power from "@bunaway/plugin-power";
import {
  type HostContext,
  type HostResponse,
  NativeRegistry,
} from "@bunaway/protocol";
import { Channel } from "#native/windows/bun/channel";
import { bundleIOPluginFixture } from "../fixtures/native-worker.ts";

const WORKER_TIMEOUT_MS = 10000;
const MAX_PACKET_TRACE = 16;

test.skipIf(process.platform !== "win32")(
  "compiled public power API crosses the real I/O worker and obeys operation grants",
  async () => {
    const root = await mkdtemp(resolve(tmpdir(), "bunaway-power-worker-"));
    const runtime = {
      id: "power-worker",
      generation: crypto.randomUUID(),
    };
    const registration = {
      name: power._definition.name,
      version: power._definition.version,
      native: power._definition.native,
    };
    const registry = new NativeRegistry([
      registration,
    ]);
    let policy = {
      permissions: [
        "power.getStatus",
      ],
    };
    const contextId = crypto.randomUUID() as HostContext;
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
      const assets = resolve(root, "worker");
      await bundleIOPluginFixture(
        assets,
        [
          {
            ...registration,
            thread: "worker",
          },
        ],
        `import power from ${JSON.stringify(resolve(import.meta.dir, "../../plugins/power/dist/native/windows.js"))};
export const pluginImports = { power: { operations: async () => ({ createOperations: power._definition.nativePlatforms.windows.create }) } };`,
      );
      worker = new Worker(resolve(assets, "host-operations.js"), {
        workerData: {
          runtime,
          dataRoot: root,
          assets,
          plugins: [
            registration,
          ],
        },
      });
      const exited = new Promise<number>((done) => worker?.once("exit", done));
      worker.once("error", fail);
      worker.once("exit", (code) => {
        if (pending.size) {
          fail(new Error(`Power worker exited before replying: ${code}`));
        }
      });
      const connection = new Channel(
        worker,
        runtime,
        "main-io",
        (packet) => {
          packetTrace.push(packet.kind);
          if (packetTrace.length > MAX_PACKET_TRACE) {
            packetTrace.shift();
          }
          if (packet.kind === "ready") {
            ready = true;
          } else if (packet.kind === "authorize-input") {
            connection.notify({
              kind: "input-authorized",
              requestId: packet.requestId,
              context: packet.context,
              allowed: registry.allowed(policy, packet.call),
            });
          } else if (packet.kind === "prepare") {
            connection.notify({
              kind: "grant",
              requestId: packet.requestId,
              context: packet.context,
              allowed: registry.allowed(policy, packet.call),
            });
          } else if (packet.kind === "host-response") {
            const settle = pending.get(packet.requestId);
            pending.delete(packet.requestId);
            settle?.resolve(packet.response);
          } else if (packet.kind === "cleaned") {
            cleaned = true;
          } else {
            throw new Error(`Unexpected power worker packet: ${packet.kind}`);
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
          throw new Error("Power worker startup timed out.");
        }
        await Bun.sleep(1);
      }
      const controller = new AbortController();
      const context: CommandContext = {
        signal: controller.signal,
        host: bindHostAPI(
          contextId,
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
            const deadline = new Promise<never>((_done, reject) => {
              timeout = setTimeout(() => {
                const error = new Error(
                  `Power worker ${call.operation} timed out. Packets: ${packetTrace.join(", ")}`,
                );
                fail(error);
                reject(error);
              }, WORKER_TIMEOUT_MS);
            });
            try {
              const sent = connection.send({
                kind: "operation",
                requestId,
                context: contextId,
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
                deadline,
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
      };
      const exercise = command({
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
          policy = {
            permissions: power._definition.native.operations.map(
              (operation) => operation.name,
            ),
          };
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
      });
      await exercise.run(null, context);
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
  },
  20000,
);
