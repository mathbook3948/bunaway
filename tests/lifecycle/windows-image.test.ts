import { expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { bindCommandHost } from "@bunaway/plugin-api/host";
import { image, imagePlugin } from "@bunaway/plugin-image";
import {
  type HostCall,
  type HostContext,
  type HostResponse,
  type JsonValue,
  NativeRegistry,
} from "@bunaway/protocol";
import { bindHostAPI } from "#core/host-api";
import { Channel, type UIConfig } from "#native/windows/bun/channel";
import { MAX_IMAGE_BYTES } from "#plugins/image/src/contract";
import { bundleUIPluginFixture } from "../fixtures/native-worker.ts";

test.skipIf(process.platform !== "win32")(
  "public image SDK uses real WIC through the UI Worker and disposes resources on shutdown",
  async () => {
    const root = resolve(
      import.meta.dir,
      `../../build/windows-image-${crypto.randomUUID()}`,
    );
    await mkdir(root, {
      recursive: true,
    });
    const registry = new NativeRegistry([
      imagePlugin,
    ]);
    const contextId = "image-native" as HostContext;
    const config: UIConfig = {
      runtime: {
        id: "image-native",
        generation: "1",
      },
      policy: {
        version: 1,
        views: [],
        backend: {
          permissions: [
            ...registry.operations.keys(),
          ],
        },
      },
      backendContext: contextId,
      windows: [],
      assets: root,
      dataRoot: root,
      loader: "",
      plugins: [
        imagePlugin,
      ],
    };
    const pending = new Map<string, (response: HostResponse) => void>();
    const disposedPath = resolve(root, "disposed.txt");
    const createdPath = resolve(root, "created.txt");
    let channel: Channel | undefined;
    let worker: Worker | undefined;
    let fatal: unknown;
    let cleaned = false;
    try {
      const nativePath = resolve(
        import.meta.dir,
        "../../plugins/image/dist/native/windows.js",
      );
      await bundleUIPluginFixture(
        root,
        [
          {
            name: "image",
            version: imagePlugin.version,
            native: imagePlugin.native,
            execution: "ui",
          },
        ],
        `
import imageDefinition from ${JSON.stringify(nativePath)};
import { writeFileSync } from "node:fs";
export const pluginImports = { image: { operations: async () => ({ createOperations(environment) {
  const adapter = imageDefinition.nativePlatforms.windows.create(environment);
  return { ...adapter, busy: () => true, async executeUI(name, input, source, context) {
    console.log(JSON.stringify({ event: "image-test-operation", name, phase: "begin" }));
    let result;
    try { result = await adapter.executeUI(name, input, source, context); }
    catch (error) { console.log(JSON.stringify({ event: "image-test-operation", name, phase: "error", error: String(error) })); throw error; }
    console.log(JSON.stringify({ event: "image-test-operation", name, phase: "done" }));
    // Hold one allocated result so the real host can cancel before delivery.
    if (name === "image.createRGBA" && input.rgba === "CAcGBQ==") {
      writeFileSync(${JSON.stringify(createdPath)}, "created");
      if (!context.signal.aborted) await new Promise((done) => context.signal.addEventListener("abort", done, { once: true }));
    }
    return result;
  }, async dispose() {
    await adapter.dispose(); await adapter.dispose();
    writeFileSync(${JSON.stringify(disposedPath)}, "disposed");
  } };
} }) } };
`,
      );
      worker = new Worker(pathToFileURL(resolve(root, "ui.js")), {
        workerData: config,
      });
      function failPending(error: unknown) {
        fatal = error;
        for (const finish of [
          ...pending.values(),
        ]) {
          finish({
            kind: "error",
            error: {
              code: "INTERNAL",
              message: String(error).slice(0, 500),
            },
          });
        }
      }
      const exited = new Promise<number>((done, fail) => {
        worker?.once("exit", done);
        worker?.once("error", (error) => {
          failPending(error);
          fail(error);
        });
      });
      let readyResolve = () => {};
      const ready = new Promise<void>((done) => {
        readyResolve = done;
      });
      let grantAllowed = true;
      channel = new Channel(
        worker,
        config.runtime,
        "main",
        (packet) => {
          if (packet.kind === "ready") {
            readyResolve();
          } else if (packet.kind === "prepare") {
            channel?.notify({
              kind: "grant",
              context: packet.context,
              requestId: packet.requestId,
              allowed: grantAllowed,
            });
          } else if (packet.kind === "host-response") {
            pending.get(packet.requestId)?.(packet.response);
          } else if (packet.kind === "cleaned") {
            cleaned = true;
          } else if (packet.kind === "fatal") {
            failPending(packet.error);
            readyResolve();
          }
        },
        (error) => {
          failPending(error);
          readyResolve();
        },
      );
      await Promise.race([
        ready,
        Bun.sleep(5000).then(() => {
          throw new Error("Image UI startup timed out.");
        }),
      ]);
      expect(fatal).toBeUndefined();
      const dispatch = (
        context: HostContext,
        call: HostCall,
        signal: AbortSignal,
      ): Promise<HostResponse> =>
        new Promise((done) => {
          const requestId = crypto.randomUUID();
          const finish = (response: HostResponse) => {
            clearTimeout(timer);
            pending.delete(requestId);
            signal.removeEventListener("abort", cancel);
            done(response);
          };
          const cancel = () => {
            channel?.notify({
              kind: "cancel",
              context,
              requestId,
            });
            finish({
              kind: "error",
              error: {
                code: "CANCELLED",
                message: "Image test call cancelled.",
              },
            });
          };
          const timer = setTimeout(
            () =>
              finish({
                kind: "error",
                error: {
                  code: "TIMEOUT",
                  message: `Image test timed out: ${call.operation}`,
                },
              }),
            5000,
          );
          pending.set(requestId, finish);
          signal.addEventListener("abort", cancel, {
            once: true,
          });
          channel?.notify({
            kind: "operation",
            context,
            requestId,
            call,
            source: "backend",
          });
        });
      async function invoke<T extends JsonValue>(
        run: () => Promise<T>,
        controller = new AbortController(),
      ): Promise<T> {
        const host = bindHostAPI(
          contextId,
          controller.signal,
          (context, call) => dispatch(context, call, controller.signal),
          registry,
        );
        const command = bindCommandHost({
          input: {
            const: null,
          },
          output: {},
          run: (
            _input: unknown,
            _context: import("@bunaway/plugin-api").CommandContext,
          ) => run(),
        });
        return command.run(null, {
          signal: controller.signal,
          host,
          state: {
            get: () => undefined,
            set() {},
            delete: () => false,
          },
          events: {
            async emit() {},
          },
        });
      }
      const pixels = {
        width: 2,
        height: 2,
        rgba: Buffer.from([
          255,
          0,
          0,
          128,
          0,
          255,
          0,
          255,
          0,
          0,
          255,
          0,
          11,
          22,
          33,
          44,
        ]).toString("base64"),
      };
      const source = await invoke(() => image.createRGBA(pixels));
      expect(
        await invoke(() =>
          image.getInfo({
            id: source.id,
          }),
        ),
      ).toEqual({
        width: 2,
        height: 2,
        empty: false,
      });
      expect(
        await invoke(() =>
          image.getPixels({
            id: source.id,
          }),
        ),
      ).toEqual(pixels);
      const png = await invoke(() =>
        image.exportBytes({
          id: source.id,
          format: "image/png",
        }),
      );
      expect(png.mime).toBe("image/png");
      expect(Buffer.from(png.data, "base64").subarray(0, 8)).toEqual(
        Buffer.from([
          137,
          80,
          78,
          71,
          13,
          10,
          26,
          10,
        ]),
      );
      const fromBytes = await invoke(() => image.createBytes(png));
      expect(
        await invoke(() =>
          image.getPixels({
            id: fromBytes.id,
          }),
        ),
      ).toEqual(pixels);
      const url = await invoke(() =>
        image.exportDataURL({
          id: source.id,
          format: "image/png",
        }),
      );
      const fromURL = await invoke(() =>
        image.createDataURL({
          url,
        }),
      );
      expect(
        await invoke(() =>
          image.getPixels({
            id: fromURL.id,
          }),
        ),
      ).toEqual(pixels);
      await expect(
        invoke(() =>
          image.exportBytes({
            id: source.id,
            format: "image/jpeg",
          }),
        ),
      ).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
      });
      await expect(
        invoke(() =>
          image.exportBytes({
            id: source.id,
            format: "image/bmp",
          }),
        ),
      ).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
      });
      const opaque = {
        width: 8,
        height: 8,
        rgba: Buffer.from(
          Array.from(
            {
              length: 64,
            },
            () => [
              255,
              0,
              0,
              255,
            ],
          ).flat(),
        ).toString("base64"),
      };
      const opaqueResource = await invoke(() => image.createRGBA(opaque));
      for (const format of [
        "image/jpeg",
        "image/bmp",
      ] as const) {
        const encoded = await invoke(() =>
          image.exportBytes({
            id: opaqueResource.id,
            format,
          }),
        );
        const decoded = await invoke(() => image.createBytes(encoded));
        const result = await invoke(() =>
          image.getPixels({
            id: decoded.id,
          }),
        );
        expect(result.width).toBe(8);
        expect(result.height).toBe(8);
        const rgba = Buffer.from(result.rgba, "base64");
        if (format === "image/bmp") {
          expect(result).toEqual(opaque);
        } else {
          expect(rgba[0]).toBeGreaterThan(245);
          expect(rgba[1]).toBeLessThan(10);
          expect(rgba[2]).toBeLessThan(10);
          expect(rgba[3]).toBe(255);
        }
        expect(
          await invoke(() =>
            image.dispose({
              id: decoded.id,
            }),
          ),
        ).toBe(true);
      }
      const empty = await invoke(() =>
        image.createRGBA({
          width: 0,
          height: 0,
          rgba: "",
        }),
      );
      expect(
        await invoke(() =>
          image.getInfo({
            id: empty.id,
          }),
        ),
      ).toEqual({
        width: 0,
        height: 0,
        empty: true,
      });
      expect(
        await invoke(() =>
          image.getPixels({
            id: empty.id,
          }),
        ),
      ).toEqual({
        width: 0,
        height: 0,
        rgba: "",
      });
      await expect(
        invoke(() =>
          image.exportBytes({
            id: empty.id,
            format: "image/png",
          }),
        ),
      ).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
      });
      for (const data of [
        "AA==",
        png.data.slice(0, 16),
        Buffer.from("malformed").toString("base64"),
      ]) {
        await expect(
          invoke(() =>
            image.createBytes({
              mime: "image/png",
              data,
            }),
          ),
        ).rejects.toMatchObject({
          code: "INVALID_ARGUMENT",
        });
      }
      // A valid BMP header with excessive decoded dimensions must fail before pixel allocation.
      const oversized = Buffer.alloc(58);
      oversized.write("BM", 0);
      oversized.writeUInt32LE(58, 2);
      oversized.writeUInt32LE(54, 10);
      oversized.writeUInt32LE(40, 14);
      oversized.writeInt32LE(4096, 18);
      oversized.writeInt32LE(4096, 22);
      oversized.writeUInt16LE(1, 26);
      oversized.writeUInt16LE(24, 28);
      await expect(
        invoke(() =>
          image.createBytes({
            mime: "image/bmp",
            data: oversized.toString("base64"),
          }),
        ),
      ).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
      });
      // Fill all rows without exceeding Web Crypto's per-call random byte limit.
      const maximumPixels = Buffer.alloc(MAX_IMAGE_BYTES);
      for (let offset = 0; offset < maximumPixels.length; offset += 65536) {
        crypto.getRandomValues(maximumPixels.subarray(offset, offset + 65536));
      }
      const maximumResource = await invoke(() =>
        image.createRGBA({
          width: 512,
          height: 256,
          rgba: maximumPixels.toString("base64"),
        }),
      );
      const maximumPNG = await invoke(() =>
        image.exportBytes({
          id: maximumResource.id,
          format: "image/png",
        }),
      );
      const maximumDecoded = await invoke(() => image.createBytes(maximumPNG));
      expect(
        await invoke(() =>
          image.getPixels({
            id: maximumDecoded.id,
          }),
        ),
      ).toEqual({
        width: 512,
        height: 256,
        rgba: maximumPixels.toString("base64"),
      });
      grantAllowed = false;
      await expect(
        invoke(() =>
          image.getInfo({
            id: source.id,
          }),
        ),
      ).rejects.toMatchObject({
        code: "PERMISSION_DENIED",
      });
      grantAllowed = true;
      expect(
        await invoke(() =>
          image.getPixels({
            id: source.id,
          }),
        ),
      ).toEqual(pixels);
      expect(
        await invoke(() =>
          image.dispose({
            id: source.id,
          }),
        ),
      ).toBe(true);
      expect(
        await invoke(() =>
          image.dispose({
            id: source.id,
          }),
        ),
      ).toBe(false);
      await expect(
        invoke(() =>
          image.getPixels({
            id: source.id,
          }),
        ),
      ).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
      });
      for (const id of [
        fromBytes.id,
        fromURL.id,
        opaqueResource.id,
        empty.id,
        maximumResource.id,
        maximumDecoded.id,
      ]) {
        expect(
          await invoke(() =>
            image.dispose({
              id,
            }),
          ),
        ).toBe(true);
      }
      const controller = new AbortController();
      const cancelled = invoke(
        () =>
          image.createRGBA({
            width: 1,
            height: 1,
            rgba: "CAcGBQ==",
          }),
        controller,
      );
      const createdDeadline = Date.now() + 2000;
      while (!(await Bun.file(createdPath).exists())) {
        if (Date.now() > createdDeadline) {
          throw new Error("Held image creation timed out.");
        }
        await Bun.sleep(5);
      }
      controller.abort();
      await expect(cancelled).rejects.toMatchObject({
        code: "CANCELLED",
      });
      // Filling every slot proves that cancellation removed the undelivered ID.
      for (let count = 0; count < 64; count++) {
        await invoke(() =>
          image.createRGBA({
            width: 0,
            height: 0,
            rgba: "",
          }),
        );
      }
      await expect(
        invoke(() =>
          image.createRGBA({
            width: 0,
            height: 0,
            rgba: "",
          }),
        ),
      ).rejects.toMatchObject({
        code: "BUSY",
      });
      channel.notify({
        kind: "shutdown",
      });
      expect(await exited).toBe(0);
      expect(fatal).toBeUndefined();
      expect(cleaned).toBe(true);
      expect(await Bun.file(disposedPath).text()).toBe("disposed");
    } finally {
      channel?.close();
      await worker?.terminate();
      await rm(root, {
        recursive: true,
        force: true,
      });
    }
  },
  30000,
);
