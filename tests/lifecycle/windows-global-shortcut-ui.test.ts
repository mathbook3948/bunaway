import { dlopen } from "bun:ffi";
import { expect, test } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { globalShortcutPlugin } from "@bunaway/plugin-global-shortcut";
import type { HostResponse, JsonValue } from "@bunaway/protocol";
import { Channel, type UIConfig } from "#native/windows/bun/channel";
import { bundleUIPluginFixture } from "../fixtures/native-worker.ts";

test.skipIf(process.platform !== "win32")(
  "packaged global shortcut SDK runs in the real windowless UI Worker and cleans its HWND",
  async () => {
    const root = await mkdtemp(resolve(tmpdir(), "bunaway-shortcut-ui-"));
    const hwndPath = resolve(root, "hwnd.txt");
    const pending = new Map<string, (response: HostResponse) => void>();
    let worker: Worker | undefined;
    let channel: Channel | undefined;
    let failure: unknown;
    let cleaned = false;
    const native = dlopen("user32.dll", {
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
        "../../plugins/global-shortcut/dist/native/windows.js",
      );
      await bundleUIPluginFixture(
        root,
        [
          {
            name: globalShortcutPlugin.name,
            version: globalShortcutPlugin.version,
            native: globalShortcutPlugin.native,
            execution: "ui",
          },
        ],
        `
import plugin from ${JSON.stringify(entrypoint)};
import { writeFileSync } from "node:fs";
export const pluginImports = { globalShortcut: { operations: async () => ({ createOperations(environment) {
  const services = environment.shortcuts;
  return plugin.nativePlatforms.windows.create({ ...environment, shortcuts: { ...services,
    createWindow(receive) { const hwnd = services.createWindow(receive); writeFileSync(${JSON.stringify(hwndPath)}, hwnd.toString()); return hwnd; },
  } });
} }) } };`,
      );
      const config: UIConfig = {
        runtime: {
          id: "shortcut-native",
          generation: crypto.randomUUID(),
        },
        backendContext: "backend" as UIConfig["backendContext"],
        windows: [],
        assets: root,
        dataRoot: root,
        loader: "",
        desktop: {
          closeBehavior: "keep-alive",
        },
        plugins: [
          globalShortcutPlugin,
        ],
        policy: {
          version: 1,
          views: [],
          backend: {
            permissions: globalShortcutPlugin.native.operations.map(
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
          throw new Error("Shortcut worker startup timed out.");
        }),
      ]);
      expect(failure).toBeUndefined();
      const invoke = (operation: string, payload: JsonValue) =>
        new Promise<JsonValue>((done, reject) => {
          const requestId = crypto.randomUUID();
          const timeout = setTimeout(() => {
            pending.delete(requestId);
            reject(
              new Error(
                `Shortcut call timed out: ${operation}; worker failure: ${String(failure)}`,
              ),
            );
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
              operation: `globalShortcut.${operation}`,
              payload,
            },
          });
        });
      const shortcut = {
        key: "F22",
        modifiers: [
          "Control",
          "Alt",
          "Shift",
        ],
      };
      await invoke("register", shortcut);
      const hwnd = BigInt(await readFile(hwndPath, "utf8"));
      expect(native.symbols.IsWindow(hwnd)).toBe(1);
      expect(native.symbols.IsWindowVisible(hwnd)).toBe(0);
      expect(await invoke("isRegistered", shortcut)).toBe(true);
      await expect(invoke("register", shortcut)).rejects.toMatchObject({
        code: "BUSY",
      });
      await invoke("setSuspended", {
        suspended: true,
      });
      expect(await invoke("isSuspended", null)).toBe(true);
      expect(await invoke("isRegistered", shortcut)).toBe(true);
      await invoke("setSuspended", {
        suspended: false,
      });
      channel.notify({
        kind: "shutdown",
      });
      expect(
        await Promise.race([
          exited,
          Bun.sleep(10000).then(() => {
            throw new Error("Shortcut worker cleanup timed out.");
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
