import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import clipboard from "@bunaway/plugin-clipboard";
import type { HostResponse, JsonValue } from "@bunaway/protocol";
import { Channel, type UIConfig } from "#native/windows/bun/channel";
import { MAX_BOOKMARK_LENGTH } from "#plugins/clipboard/src/contract";
import { testAppMetadata } from "../fixtures/app-info.ts";
import { writePluginFixture } from "../fixtures/native-worker.ts";
import {
  uiCleanupSlots,
  uiLifecycleSlots,
} from "../fixtures/windows-ui-cleanup.ts";
import { deadline } from "../fixtures/deadlines.ts";

setDefaultTimeout(deadline("toolchain"));

test("clipboard resource failures and cancellable retries use isolated Win32 bindings", async () => {
  const root = resolve(
    import.meta.dir,
    `../../build/clipboard-resources-${crypto.randomUUID()}`,
  );
  const replacement = resolve(import.meta.dir, "../fixtures/clipboard-ffi.ts");
  await mkdir(root, {
    recursive: true,
  });
  try {
    let substituted = false;
    const build = await Bun.build({
      entrypoints: [
        resolve(import.meta.dir, "../fixtures/clipboard-resources.fixture.ts"),
      ],
      target: "bun",
      outdir: root,
      plugins: [
        {
          name: "clipboard-test-bindings",
          setup(builder) {
            builder.onLoad(
              {
                filter:
                  /[\\/]clipboard[\\/]src[\\/]platforms[\\/]windows-bindings\.ts$/,
              },
              async (args) => {
                substituted = true;
                return {
                  contents: (await Bun.file(args.path).text()).replace(
                    '"bun:ffi"',
                    JSON.stringify(replacement),
                  ),
                  loader: "ts",
                };
              },
            );
          },
        },
      ],
    });
    expect(build.success).toBe(true);
    expect(substituted).toBe(true);
    const child = Bun.spawn(
      [
        process.execPath,
        build.outputs[0]?.path ?? "",
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect({
      exit,
      stderr,
    }).toEqual({
      exit: 0,
      stderr: "",
    });
    expect(stdout).toContain(
      "ownership, failure, retry, cancellation and disposal passed",
    );
  } finally {
    await rm(root, {
      recursive: true,
      force: true,
    });
  }
});

test("clipboard invalid bookmarks return errors through the production UI Worker and preserve its clipboard", async () => {
  const root = resolve(
    import.meta.dir,
    `../../build/clipboard-ui-validation-${crypto.randomUUID()}`,
  );
  const configuration: UIConfig = {
    appMetadata: testAppMetadata,
    runtime: {
      id: "clipboard-ui-validation",
      generation: crypto.randomUUID(),
    },
    policy: {
      version: 1,
      views: [],
      backend: {
        permissions: [
          "clipboard.writeFormats",
          "clipboard.readText",
        ],
      },
    },
    backendContext: "backend" as UIConfig["backendContext"],
    windows: [],
    assets: root,
    dataRoot: root,
    loader: "",
    plugins: [
      clipboard._definition,
    ],
  };
  const cleanup = new SharedArrayBuffer(
    Object.keys(uiCleanupSlots).length * Int32Array.BYTES_PER_ELEMENT,
  );
  // The platform fixture polls these slots on every pump, so the buffer must exist even when unused.
  const lifecycle = new SharedArrayBuffer(
    Object.keys(uiLifecycleSlots).length * Int32Array.BYTES_PER_ELEMENT,
  );
  let worker: Worker | undefined;
  let channel: Channel | undefined;
  try {
    const definitionPath = resolve(
      import.meta.dir,
      "../../plugins/clipboard/src/index.ts",
    );
    await writePluginFixture(
      root,
      [
        {
          name: "clipboard",
          version: clipboard._definition.version,
          native: clipboard._definition.native,
          thread: "ui",
        },
      ],
      `
import definition from ${JSON.stringify(definitionPath)};
export const pluginImports = { clipboard: { operations: async () => ({ createOperations(environment) {
  const adapter = definition._definition.nativePlatforms.windows.create(environment);
  return { ...adapter, busy: () => true };
} }) } };
`,
    );
    const replacement = resolve(
      import.meta.dir,
      "../fixtures/clipboard-ffi.ts",
    );
    const build = await Bun.build({
      entrypoints: [
        resolve(import.meta.dir, "../../native/windows/bun/ui.ts"),
      ],
      target: "bun",
      outdir: root,
      plugins: [
        {
          name: "clipboard-ui-native-boundary",
          setup(builder) {
            builder.onResolve(
              {
                filter:
                  /^\.\/(com|tray|webview|win32|win32-bindings|monitors)\.ts$/,
              },
              () => ({
                path: resolve(
                  import.meta.dir,
                  "../fixtures/windows-ui-platform.ts",
                ),
              }),
            );
            builder.onResolve(
              {
                filter: /^bunaway:plugin-imports$/,
              },
              () => ({
                path: resolve(root, "plugin-imports.js"),
              }),
            );
            builder.onLoad(
              {
                filter:
                  /[\\/]clipboard[\\/]src[\\/]platforms[\\/]windows-bindings\.ts$/,
              },
              async (args) => ({
                contents: (await Bun.file(args.path).text()).replace(
                  '"bun:ffi"',
                  JSON.stringify(replacement),
                ),
                loader: "ts",
              }),
            );
          },
        },
      ],
    });
    expect(build.success, build.logs.map(String).join("\n")).toBe(true);
    worker = new Worker(pathToFileURL(resolve(root, "ui.js")), {
      workerData: {
        ...configuration,
        cleanup,
        lifecycle,
      },
      stdout: true,
      stderr: true,
    });
    let errors = "";
    worker.stderr?.on("data", (bytes) => {
      errors += String(bytes);
    });
    worker.stdout?.resume();
    let failure: unknown;
    worker.on("error", (error) => {
      failure = error;
    });
    const exit = new Promise<number>((done) => worker?.once("exit", done));
    let ready = false;
    let cleaned = false;
    const responses = new Map<string, HostResponse>();
    channel = new Channel(
      worker,
      configuration.runtime,
      "main",
      (packet) => {
        if (packet.kind === "ready") {
          ready = true;
        } else if (packet.kind === "prepare") {
          channel?.notify({
            kind: "grant",
            requestId: packet.requestId,
            context: packet.context,
            allowed: true,
          });
        } else if (packet.kind === "host-response") {
          responses.set(packet.requestId, packet.response);
        } else if (packet.kind === "fatal") {
          failure = packet.error;
        } else if (packet.kind === "cleaned") {
          cleaned = true;
        }
      },
      (error) => {
        failure = error;
      },
    );
    const waitFor = async (condition: () => boolean) => {
      const limit = Date.now() + deadline("inProcess");
      while (!condition()) {
        expect(failure, errors).toBeUndefined();
        if (Date.now() >= limit) {
          throw new Error(`Clipboard UI validation timed out. ${errors}`);
        }
        await Bun.sleep(5);
      }
    };
    await waitFor(() => ready);
    const call = async (operation: string, payload: JsonValue) => {
      const requestId = crypto.randomUUID();
      await channel?.send({
        kind: "operation",
        requestId,
        context: configuration.backendContext,
        call: {
          operation,
          payload,
        },
        source: "backend",
      });
      await waitFor(() => responses.has(requestId));
      const response = responses.get(requestId);
      responses.delete(requestId);
      return response;
    };
    for (const url of [
      `https://example.com/${"😀".repeat(1024)}`,
      `https://example.com/${"x".repeat(MAX_BOOKMARK_LENGTH)}`,
    ]) {
      expect(
        await call("clipboard.writeFormats", {
          items: [
            {
              format: "application/x-bunaway-bookmark",
              data: {
                url,
              },
            },
          ],
        }),
      ).toMatchObject({
        kind: "error",
        error: {
          code: "INVALID_ARGUMENT",
        },
      });
      expect(await call("clipboard.readText", null)).toEqual({
        kind: "result",
        payload: "old",
      });
      expect(failure).toBeUndefined();
    }
    await channel.send({
      kind: "shutdown",
    });
    await waitFor(() => cleaned);
    expect(await exit, errors).toBe(0);
    expect(failure).toBeUndefined();
  } finally {
    channel?.close();
    await worker?.terminate();
    await rm(root, {
      recursive: true,
      force: true,
    });
  }
});
