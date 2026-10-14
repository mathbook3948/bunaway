import { dlopen } from "bun:ffi";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { trayPlugin } from "@bunaway/plugin-tray";
import type { HostResponse, JsonValue } from "@bunaway/protocol";
import { Channel, type UIConfig } from "#native/windows/bun/channel";
import { bundleUIPluginFixture } from "../fixtures/native-worker.ts";
import { trayIco } from "../fixtures/tray-icon.ts";

test.skipIf(process.platform !== "win32")(
  "packaged tray SDK updates the windowless UI Worker and completes backend mouse waits",
  async () => {
    const root = await mkdtemp(resolve(tmpdir(), "bunaway-tray-ui-"));
    let worker: Worker | undefined;
    let channel: Channel | undefined;
    let failure: unknown;
    let cleaned = false;
    let hwnd = 0n;
    const pending = new Map<string, (response: HostResponse) => void>();
    const native = dlopen("user32.dll", {
      PostMessageW: {
        args: [
          "u64",
          "u32",
          "u64",
          "i64",
        ],
        returns: "i32",
      },
      IsWindow: {
        args: [
          "u64",
        ],
        returns: "i32",
      },
      IsWindowVisible: {
        args: [
          "u64",
        ],
        returns: "i32",
      },
    });
    try {
      const entrypoint = resolve(
        import.meta.dir,
        "../../plugins/tray/dist/native/windows.js",
      );
      await bundleUIPluginFixture(
        root,
        [
          {
            name: trayPlugin.name,
            version: trayPlugin.version,
            native: trayPlugin.native,
            thread: "ui",
          },
        ],
        `import plugin from ${JSON.stringify(entrypoint)}; export const pluginImports = { tray: { operations: async () => ({ createOperations: plugin.nativePlatforms.windows.create }) } };`,
      );
      const config: UIConfig = {
        runtime: {
          id: "tray-controls",
          generation: crypto.randomUUID(),
        },
        backendContext: "backend" as UIConfig["backendContext"],
        windows: [],
        assets: root,
        dataRoot: root,
        loader: "",
        desktop: {
          closeBehavior: "keep-alive",
          tray: {
            tooltip: `${"😀".repeat(63)}x`,
          },
        },
        plugins: [
          trayPlugin,
        ],
        policy: {
          version: 1,
          views: [],
          backend: {
            permissions: trayPlugin.native.operations.map(
              (operation) => operation.name,
            ),
          },
        },
      };
      worker = new Worker(pathToFileURL(resolve(root, "ui.js")), {
        workerData: config,
      });
      const exited = new Promise<number>((done, reject) => {
        worker?.once("exit", done);
        worker?.once("error", reject);
      });
      let readyResolve = () => {};
      const ready = new Promise<void>((done) => {
        readyResolve = done;
      });
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
              allowed: true,
            });
          } else if (packet.kind === "host-response") {
            pending.get(packet.requestId)?.(packet.response);
          } else if (packet.kind === "cleaned") {
            cleaned = true;
          } else if (packet.kind === "fatal") {
            failure = packet.error;
            readyResolve();
          } else if (
            packet.kind === "diagnostic" &&
            packet.event === "tray-created" &&
            typeof packet.fields.hwnd === "string"
          ) {
            hwnd = BigInt(packet.fields.hwnd);
          }
        },
        (error) => {
          failure = error;
          readyResolve();
        },
      );
      await Promise.race([
        ready,
        Bun.sleep(10000).then(() => {
          throw new Error("Tray worker startup timed out.");
        }),
      ]);
      expect(failure).toBeUndefined();
      expect(hwnd).not.toBe(0n);
      const invoke = (operation: string, payload: JsonValue) =>
        new Promise<JsonValue>((done, reject) => {
          const requestId = crypto.randomUUID();
          const timeout = setTimeout(() => {
            pending.delete(requestId);
            reject(new Error(`Tray call timed out: ${operation}`));
          }, 5000);
          pending.set(requestId, (response) => {
            clearTimeout(timeout);
            pending.delete(requestId);
            if (response.kind === "result") {
              done(response.payload);
            } else {
              reject(response.error);
            }
          });
          channel?.notify({
            kind: "operation",
            context: config.backendContext,
            requestId,
            source: "backend",
            call: {
              operation: `tray.${operation}`,
              payload,
            },
          });
        });
      expect(await invoke("get", null)).toMatchObject({
        id: "main",
        tooltip: `${"😀".repeat(63)}x`,
      });
      await invoke("setTooltip", {
        tooltip: "한글 😀",
      });
      await invoke("setIcon", {
        ico: trayIco().toString("base64"),
      });
      await invoke("setClickBehavior", {
        showOnLeftClick: false,
        menuOnRightClick: false,
      });
      expect(await invoke("get", null)).toMatchObject({
        id: "main",
        tooltip: "한글 😀",
        icon: "custom",
        showOnLeftClick: false,
        menuOnRightClick: false,
      });
      const notification = invoke("waitForEvent", null);
      // A subsequent round-trip ensures the native waiter is installed before synthetic input.
      await invoke("get", null);
      expect(native.symbols.PostMessageW(hwnd, 0x8001, 1n, 0x208n)).not.toBe(0);
      expect(await notification).toMatchObject({
        id: "main",
        button: "middle",
        state: "up",
      });
      expect(native.symbols.IsWindowVisible(hwnd)).toBe(0);
      await channel.send({
        kind: "operation",
        context: config.backendContext,
        requestId: "pending-input",
        source: "backend",
        call: {
          operation: "tray.waitForEvent",
          payload: null,
        },
      });
      await invoke("get", null);
      channel.notify({
        kind: "shutdown",
      });
      expect(
        await Promise.race([
          exited,
          Bun.sleep(10000).then(() => {
            throw new Error("Tray worker cleanup timed out.");
          }),
        ]),
      ).toBe(0);
      expect(cleaned).toBe(true);
      expect(failure).toBeUndefined();
      expect(native.symbols.IsWindow(hwnd)).toBe(0);
    } finally {
      channel?.close();
      await worker?.terminate();
      native.close();
      await rm(root, {
        recursive: true,
        force: true,
      });
    }
  },
  30000,
);
