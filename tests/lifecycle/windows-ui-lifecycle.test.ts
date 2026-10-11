import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { validateWindowOutput, windowsPlugin } from "@bunaway/plugin-windows";
import type { JsonValue } from "@bunaway/protocol";
import {
  Channel,
  type Packet,
  type UIConfig,
} from "#native/windows/bun/channel";
import { writePluginFixture } from "../fixtures/native-worker.ts";
import { windowPermissions } from "../fixtures/window-permissions.ts";

const timeoutMs = 10_000;

/** Run the production UI loop and window adapter with controlled Win32/WebView callbacks. */
async function startUI(failView?: string) {
  const directory = await mkdtemp(resolve(tmpdir(), "bunaway-ui-lifecycle-"));
  const configuration: UIConfig = {
    runtime: {
      id: "ui-lifecycle",
      generation: crypto.randomUUID(),
    },
    backendContext: "backend" as UIConfig["backendContext"],
    assets: directory,
    dataRoot: directory,
    loader: "fixture",
    desktop: {
      closeBehavior: "keep-alive",
      tray: {
        tooltip: "Fixture",
      },
    },
    plugins: [
      {
        name: windowsPlugin.name,
        version: windowsPlugin.version,
        native: windowsPlugin.native,
      },
    ],
    windows: [
      {
        view: "main",
        title: "Main",
        home: "https://app.bunaway.local",
        window: {
          width: 800,
          height: 600,
        },
      },
      {
        view: "editor",
        title: "Editor",
        home: "https://app.bunaway.local",
        window: {
          width: 800,
          height: 600,
        },
        instances: "multiple",
        maxInstances: 3,
        startup: false,
      },
    ],
    policy: {
      version: 1,
      views: [
        "main",
        "editor",
      ].map((id) => ({
        id,
        origins: [
          "https://app.bunaway.local",
        ],
        commands: [],
        events: [],
        host: {
          permissions: [],
        },
      })),
      backend: {
        permissions: windowPermissions(),
      },
    },
  };
  await writePluginFixture(
    directory,
    [
      {
        name: windowsPlugin.name,
        version: windowsPlugin.version,
        native: windowsPlugin.native,
        execution: "ui",
      },
    ],
    `export const pluginImports = { windows: {
      operations: () => import(${JSON.stringify(resolve(import.meta.dir, "../../plugins/windows/src/platforms/windows.ts"))}),
    } };`,
  );
  const bundle = await Bun.build({
    entrypoints: [
      resolve(import.meta.dir, "../../native/windows/bun/ui.ts"),
    ],
    target: "bun",
    outdir: directory,
    plugins: [
      {
        name: "controlled-ui-platform",
        setup(build) {
          build.onResolve(
            {
              filter: /^\.\/(com|tray|webview|win32|win32-bindings)\.ts$/,
            },
            () => ({
              path: resolve(
                import.meta.dir,
                "../fixtures/windows-ui-platform.ts",
              ),
            }),
          );
          build.onResolve(
            {
              filter: /^bunaway:plugin-imports$/,
            },
            () => ({
              path: resolve(directory, "plugin-imports.js"),
            }),
          );
        },
      },
    ],
  });
  if (!bundle.success) {
    await rm(directory, {
      recursive: true,
      force: true,
    });
    throw new Error(bundle.logs.map(String).join("\n"));
  }
  const worker = new Worker(pathToFileURL(resolve(directory, "ui.js")), {
    workerData: {
      ...configuration,
      ...(failView
        ? {
            failView,
          }
        : {}),
    },
    stdout: true,
    stderr: true,
  });
  worker.stdout?.resume();
  worker.stderr?.resume();
  const packets: Packet[] = [];
  let workerError: Error | undefined;
  const exited = new Promise<number>((done) => worker.once("exit", done));
  worker.once("error", (error) => {
    workerError = error instanceof Error ? error : new Error(String(error));
  });
  let channel!: Channel;
  channel = new Channel(
    worker,
    configuration.runtime,
    "main",
    (packet) => {
      packets.push(packet);
      if (packet.kind === "prepare") {
        channel.notify({
          kind: "grant",
          context: packet.context,
          requestId: packet.requestId,
          allowed: true,
        });
      }
    },
    (error) => {
      workerError = error instanceof Error ? error : new Error(String(error));
    },
  );
  async function waitFor(condition: () => boolean | Promise<boolean>) {
    const deadline = Date.now() + timeoutMs;
    while (!(await condition())) {
      if (workerError) {
        throw workerError;
      }
      if (Date.now() > deadline) {
        throw new Error("UI lifecycle fixture timed out");
      }
      await Bun.sleep(5);
    }
  }
  async function call(operation: string, payload: JsonValue) {
    const requestId = crypto.randomUUID();
    await channel.send({
      kind: "operation",
      context: configuration.backendContext,
      requestId,
      source: "backend",
      call: {
        operation,
        payload,
      },
    });
    await waitFor(() =>
      packets.some(
        (packet) =>
          packet.kind === "host-response" && packet.requestId === requestId,
      ),
    );
    const packet = packets.find(
      (packet) =>
        packet.kind === "host-response" && packet.requestId === requestId,
    );
    if (packet?.kind !== "host-response") {
      throw new Error("Missing host response");
    }
    if (packet.response.kind === "error") {
      throw new Error(JSON.stringify(packet.response));
    }
    return packet.response.payload;
  }
  return {
    channel,
    packets,
    call,
    waitFor,
    exited,
    error: () => workerError,
    async close() {
      channel.close();
      await worker.terminate();
      await rm(directory, {
        recursive: true,
        force: true,
      });
    },
  };
}

test(
  "desktop Open restores all live single and multiple windows without creating extra lifetimes",
  async () => {
    const ui = await startUI();
    try {
      await ui.waitFor(() =>
        ui.packets.some((packet) => packet.kind === "ready"),
      );
      await ui.channel.send({
        kind: "start",
      });
      const first = await ui.call("windows.createInstance", {
        view: "editor",
      });
      const second = await ui.call("windows.createInstance", {
        view: "editor",
      });
      expect(first).not.toEqual(second);
      const identities = validateWindowOutput(
        "windows.listInstances",
        await ui.call("windows.listInstances", null),
      );
      expect(identities).toHaveLength(3);
      for (const action of [
        "hide",
        "show",
      ] as const) {
        await ui.channel.send({
          kind: "desktop-control",
          action,
        });
        for (const identity of identities) {
          // Desktop control is queued for the UI pump; wait for its observable effect.
          await ui.waitFor(
            async () =>
              (await ui.call("windows.isVisible", {
                view: identity.viewId,
                windowId: identity.windowId,
              })) ===
              (action === "show"),
          );
          expect(
            await ui.call("windows.isVisible", {
              view: identity.viewId,
              windowId: identity.windowId,
            }),
          ).toBe(action === "show");
        }
      }
      expect(await ui.call("windows.listInstances", null)).toEqual(identities);
      await ui.channel.send({
        kind: "shutdown",
      });
      expect(await ui.exited).toBe(0);
      expect(ui.error()).toBeUndefined();
    } finally {
      await ui.close();
    }
  },
  timeoutMs + 5_000,
);

test(
  "a startup controller failure reports fatal and cleans resources despite its queued forced close",
  async () => {
    const ui = await startUI("main");
    try {
      await ui.waitFor(() =>
        ui.packets.some((packet) => packet.kind === "fatal"),
      );
      expect(
        ui.packets.find((packet) => packet.kind === "fatal"),
      ).toMatchObject({
        kind: "fatal",
        error: {
          code: "INTERNAL",
          message: expect.stringContaining("Controller completion failed"),
        },
      });
      await ui.exited;
      expect(ui.error()?.message).toContain("Controller completion failed");
      expect(
        ui.packets.some(
          (packet) => packet.kind === "cleaned" || packet.kind === "closing",
        ),
      ).toBe(false);
      expect(
        ui.packets.some(
          (packet) =>
            packet.kind === "diagnostic" &&
            packet.event === "callbacks-quiescent",
        ),
      ).toBe(true);
    } finally {
      await ui.close();
    }
  },
  timeoutMs + 5_000,
);

test(
  "a runtime controller failure cleans only its instance and keeps existing windows usable",
  async () => {
    const ui = await startUI("editor");
    try {
      await ui.waitFor(() =>
        ui.packets.some((packet) => packet.kind === "ready"),
      );
      await ui.channel.send({
        kind: "start",
      });
      const failure = await ui
        .call("windows.createInstance", {
          view: "editor",
        })
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect(String(failure)).toContain("INTERNAL");
      expect(
        await ui.call("windows.isVisible", {
          view: "main",
        }),
      ).toBe(true);
      expect(await ui.call("windows.listInstances", null)).toHaveLength(1);
      expect(ui.packets.some((packet) => packet.kind === "fatal")).toBe(false);
      await ui.channel.send({
        kind: "shutdown",
      });
      expect(await ui.exited).toBe(0);
    } finally {
      await ui.close();
    }
  },
  timeoutMs + 5_000,
);
