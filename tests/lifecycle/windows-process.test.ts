import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defineApp, defineModule } from "@bunaway/backend";
import { createClient } from "@bunaway/client";
import { type CoreServices, createCore } from "@bunaway/core";
import processes from "@bunaway/plugin-process";
import nativeProcesses from "@bunaway/plugin-process/native/windows";
import {
  BunawayError,
  type ClientMessage,
  type HostContext,
  type JsonValue,
  parseMessage,
  type TransportEvent,
} from "@bunaway/protocol";
import { processOperations } from "#plugins/process/src/operations";
import { processExitProbe } from "../fixtures/process-exit-probe.ts";

test.skipIf(process.platform !== "win32")(
  "public process cancellation rejects before delayed bridge delivery and retains eventual child cleanup",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "bunaway-public-process-"));
    const pidFile = join(root, "pid");
    const platform = nativeProcesses._definition.nativePlatforms.windows;
    assert(platform);
    const adapter = platform.create({
      dataRoot: root,
      capabilities: [],
    });
    const execute = adapter.executeUI;
    assert(execute);
    const delivery = new AbortController();
    let releaseDelivery!: () => void;
    const deliveryGate = new Promise<void>((resolve) => {
      releaseDelivery = resolve;
    });
    let finishAdapter!: () => void;
    const adapterFinished = new Promise<void>((resolve) => {
      finishAdapter = resolve;
    });
    let adapterSettled = false;
    let deliveryTask: Promise<void> | undefined;
    let listener: ((event: TransportEvent) => void) | undefined;
    const grants = {
      permissions: [
        "process.run",
      ],
    };
    const services: CoreServices = {
      platform: "windows",
      backendContext: "backend" as HostContext,
      hello: {
        kind: "hello",
        protocol: {
          major: 1,
          minor: 0,
        },
        features: [],
        buildId: "public-process-test",
      },
      policy: {
        version: 1,
        backend: grants,
        views: [
          {
            id: "test",
            origins: [
              "https://app.bunaway.local",
            ],
            commands: [
              "probe.run",
            ],
            events: [],
            host: grants,
          },
        ],
      },
      runtime: {
        createCancellation: () => new AbortController(),
        now: () => Date.now(),
        schedule(callback, delay) {
          const timer = setTimeout(callback, delay);
          return () => clearTimeout(timer);
        },
      },
      async send(_context, message) {
        listener?.({
          kind: "message",
          text: JSON.stringify(message),
        });
      },
      async callHost(_context, call, signal) {
        // Model asynchronous bridge cancellation delivery without changing production transport.
        const deliverAbort = () => {
          deliveryTask = deliveryGate.then(() =>
            delivery.abort(
              new BunawayError({
                code: "CANCELLED",
                message: "Test request ended.",
              }),
            ),
          );
        };
        signal.addEventListener("abort", deliverAbort);
        try {
          return {
            kind: "result",
            payload: await execute(call.operation, call.payload, "view:test", {
              requestId: crypto.randomUUID(),
              permissions: grants,
              signal: delivery.signal,
            }),
          };
        } finally {
          signal.removeEventListener("abort", deliverAbort);
          adapterSettled = true;
          finishAdapter();
        }
      },
    };
    const module = defineModule("probe").command(
      "run",
      {
        input: {
          const: null,
        },
        output: {
          const: null,
        },
      },
      async () => {
        await processes.run({
          executablePath: process.execPath,
          args: [
            resolve(import.meta.dir, "../fixtures/process-ready.ts"),
            pidFile,
          ],
        });
        return null;
      },
    );
    const core = await createCore(
      defineApp({
        plugins: [
          processes,
        ],
        modules: [
          module,
        ],
      }),
      services,
    );
    const session = core.openSession("test" as HostContext, "test");
    const client = createClient({
      hello: services.hello,
      transport: {
        send: (text) => session.receive(parseMessage(text) as ClientMessage),
        subscribe(current) {
          listener = current;
          return () => {
            listener = undefined;
          };
        },
        close: () => session.close(),
      },
    });
    const controller = new AbortController();
    let observed: Promise<unknown> | undefined;
    let probe: ReturnType<typeof processExitProbe> | undefined;
    try {
      await client.ready;
      observed = client
        .invoke("probe.run", null, {
          signal: controller.signal,
        })
        .catch((error: unknown) => error);
      const deadline = Date.now() + 2000;
      while (!(await Bun.file(pidFile).exists())) {
        expect(Date.now()).toBeLessThan(deadline);
        await Bun.sleep(2);
      }
      probe = processExitProbe(Number(await readFile(pidFile, "utf8")));
      expect(probe.exited()).toBe(false);
      controller.abort();
      expect(await observed).toMatchObject({
        code: "CANCELLED",
      });
      expect(adapterSettled).toBe(false);
      expect(probe.exited()).toBe(false);
      releaseDelivery();
      await adapterFinished;
      expect(adapterSettled).toBe(true);
      expect(probe.exited()).toBe(true);
      await adapter.dispose();
    } finally {
      controller.abort();
      releaseDelivery();
      delivery.abort();
      await observed;
      await deliveryTask;
      await adapter.dispose();
      probe?.dispose();
      await client.close();
      await core.stop();
      await rm(root, {
        recursive: true,
        force: true,
      });
    }
  },
);

test.skipIf(process.platform !== "win32")(
  "generated Windows argv adapter handles completion, timeout, capacity and repeated disposal",
  async () => {
    const platform = nativeProcesses._definition.nativePlatforms.windows;
    assert(platform);
    const adapter = platform.create({
      dataRoot: ".",
      capabilities: [],
    });
    const call = (input: JsonValue, signal?: AbortSignal) => {
      assert(adapter.executeUI);
      return adapter.executeUI("process.run", input, "view:test", {
        requestId: crypto.randomUUID(),
        permissions: {
          permissions: [
            "process.run",
          ],
        },
        ...(signal
          ? {
              signal,
            }
          : {}),
      });
    };
    try {
      const result = processOperations.run.output.parse(
        await call({
          executablePath: process.execPath,
          args: [
            "-e",
            'process.stdout.write("한글 😀"); process.exitCode = 23;',
          ],
        }),
      );
      expect(result.exitCode).toBe(23);
      expect(Buffer.from(result.stdoutBase64, "base64").toString()).toBe(
        "한글 😀",
      );
      await expect(
        call({
          executablePath: process.execPath,
          args: [
            "-e",
            "setInterval(() => {}, 1000)",
          ],
          timeoutMs: 100,
        }),
      ).rejects.toMatchObject({
        code: "TIMEOUT",
      });
      const pending = Array.from(
        {
          length: 8,
        },
        () =>
          call({
            executablePath: process.execPath,
            args: [
              "-e",
              "setInterval(() => {}, 1000)",
            ],
          }),
      );
      const observed = Promise.allSettled(pending);
      await Bun.sleep(50);
      await expect(
        call({
          executablePath: process.execPath,
          args: [
            "-e",
            "",
          ],
        }),
      ).rejects.toMatchObject({
        code: "BUSY",
      });
      await adapter.dispose();
      await adapter.dispose();
      expect(
        (await observed).every(
          (result) =>
            result.status === "rejected" && result.reason.code === "CANCELLED",
        ),
      ).toBe(true);
      await expect(
        call({
          executablePath: process.execPath,
        }),
      ).rejects.toMatchObject({
        code: "CANCELLED",
      });
    } finally {
      await adapter.dispose();
    }
  },
);
