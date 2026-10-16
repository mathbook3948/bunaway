import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import tray from "@bunaway/plugin-tray";
import windows, { validateWindowOutput } from "@bunaway/plugin-windows";
import type { JsonValue } from "@bunaway/protocol";
import {
  Channel,
  type Packet,
  type UIConfig,
} from "#native/windows/bun/channel";
import { testAppMetadata } from "../fixtures/app-info.ts";
import { writePluginFixture } from "../fixtures/native-worker.ts";
import { windowPermissions } from "../fixtures/window-permissions.ts";
import {
  uiCleanupSlots,
  uiLifecycleSlots,
} from "../fixtures/windows-ui-cleanup.ts";

const timeoutMs = 10_000;
const parserSlots = {
  started: 0,
  released: 1,
  executions: 2,
};

/** Run the production UI loop and window adapter with controlled Win32/WebView callbacks. */
async function startUI(
  failView?: string,
  parserExecution?: "ui" | "sync",
  trayFailures?: number,
  registerTray = true,
  lifecycleOptions: {
    isolated?: boolean;
    failCreationNumber?: number;
    creationFailure?: "controller" | "constructor";
    holdProfileReuse?: boolean;
    closeBehavior?: "keep-alive" | "quit";
  } = {},
) {
  const directory = await mkdtemp(resolve(tmpdir(), "bunaway-ui-lifecycle-"));
  const parsing = new Int32Array(
    new SharedArrayBuffer(
      Object.keys(parserSlots).length * Int32Array.BYTES_PER_ELEMENT,
    ),
  );
  const cleanup = new Int32Array(
    new SharedArrayBuffer(
      Object.keys(uiCleanupSlots).length * Int32Array.BYTES_PER_ELEMENT,
    ),
  );
  const lifecycle = new Int32Array(
    new SharedArrayBuffer(
      Object.keys(uiLifecycleSlots).length * Int32Array.BYTES_PER_ELEMENT,
    ),
  );
  Atomics.store(lifecycle, uiLifecycleSlots.confirmClose, 1);
  Atomics.store(
    lifecycle,
    uiLifecycleSlots.holdProfileReuse,
    lifecycleOptions.holdProfileReuse ? 1 : 0,
  );
  const parserPlugins = parserExecution
    ? [
        {
          name: "parser",
          version: "1",
          thread: "ui" as const,
          native: {
            operations: [
              {
                name: "parser.run",
              },
            ],
          },
        },
      ]
    : [];
  const configuration: UIConfig = {
    appMetadata: testAppMetadata,
    runtime: {
      id: "ui-lifecycle",
      generation: crypto.randomUUID(),
    },
    backendContext: "backend" as UIConfig["backendContext"],
    assets: directory,
    dataRoot: directory,
    loader: "fixture",
    desktop: {
      closeBehavior: lifecycleOptions.closeBehavior ?? "keep-alive",
      tray: {
        tooltip: "Fixture",
      },
    },
    plugins: [
      {
        name: windows._definition.name,
        version: windows._definition.version,
        native: windows._definition.native,
      },
      ...(registerTray
        ? [
            tray._definition,
          ]
        : []),
      ...parserPlugins,
    ],
    windows: [
      {
        view: "main",
        title: "Main",
        ...(lifecycleOptions.isolated
          ? {
              profile: "isolated" as const,
            }
          : {}),
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
        permissions: [
          ...windowPermissions(),
          ...(parserExecution
            ? [
                "parser.run",
              ]
            : []),
        ],
      },
    },
  };
  await writePluginFixture(
    directory,
    [
      {
        name: windows._definition.name,
        version: windows._definition.version,
        native: windows._definition.native,
        thread: "ui",
      },
      {
        name: tray._definition.name,
        version: tray._definition.version,
        native: tray._definition.native,
        thread: "ui",
      },
      ...parserPlugins,
    ],
    `
    import { workerData } from "node:worker_threads";
    import { Tray, requestFixtureClose } from ${JSON.stringify(resolve(import.meta.dir, "../fixtures/windows-ui-platform.ts"))};
    import { defineNativePlugin } from ${JSON.stringify(resolve(import.meta.dir, "../../packages/plugin-sdk/src/index.ts"))};
    import { z } from ${JSON.stringify(Bun.resolveSync("zod", import.meta.dir))};
    const state = new Int32Array(workerData.parsing);
    const slots = ${JSON.stringify(parserSlots)};
    const cleanup = new Int32Array(workerData.cleanup);
    const cleanupSlots = ${JSON.stringify(uiCleanupSlots)};
    const execute = (_name,input) => {
      Atomics.add(state,slots.executions,1);
      if(input === "user-close" || input === "force-close") requestFixtureClose("main", input === "force-close");
      return input;
    };
    const parser = defineNativePlugin({name:"parser",operations:{run:{
      input:z.string().transform(async value=>{
        if(value === "wait") {
          Atomics.store(state,slots.started,1);
          while(Atomics.load(state,slots.released) === 0) await Bun.sleep(1);
        }
        return value;
      }),output:z.string(),
    }},platforms:{windows:{thread:"ui",create:()=>({
      execute,
      ...(${JSON.stringify(parserExecution)} === "ui" ? {async executeUI(name,input){return execute(name,input);}} : {}),
      dispose(){Atomics.add(cleanup,cleanupSlots.adapter,1);},
    })}}});
    export const pluginImports = {tray: {operations: async()=>({createOperations(environment){
      environment.tray.initialize(()=>new Tray()); return {execute(){throw new Error("Unexpected tray call")},dispose(){}};
    }})},parser:{operations:async()=>({createOperations:parser._definition.nativePlatforms.windows.create})}, windows: {
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
      parsing: parsing.buffer,
      cleanup: cleanup.buffer,
      lifecycle: lifecycle.buffer,
      failCreationNumber: lifecycleOptions.failCreationNumber,
      creationFailure: lifecycleOptions.creationFailure,
      trayFailures,
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
    parsing,
    cleanup,
    lifecycle,
    directory,
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

/** The production profile owner allocates this directory before controlled WebView creation. */
async function isolatedProfile(ui: { directory: string }): Promise<string> {
  const root = resolve(ui.directory, "webview", "temporary");
  const paths = await readdir(root);
  expect(paths).toHaveLength(1);
  return resolve(root, paths[0] ?? "");
}

test(
  "declined user close and recreation preserve the live lifetime and isolated profile",
  async () => {
    const ui = await startUI(undefined, "ui", undefined, true, {
      isolated: true,
    });
    const target = {
      view: "main",
    };
    try {
      await ui.waitFor(() =>
        ui.packets.some((packet) => packet.kind === "ready"),
      );
      await ui.channel.send({
        kind: "start",
      });
      const before = await ui.call("windows.getSnapshot", target);
      const profile = await isolatedProfile(ui);
      await writeFile(resolve(profile, "storage"), "private");
      await ui.call("windows.setCloseConfirmation", {
        ...target,
        message: "Close?",
      });
      Atomics.store(ui.lifecycle, uiLifecycleSlots.confirmClose, 0);
      await ui.call("parser.run", "user-close");
      await ui.waitFor(
        () => Atomics.load(ui.lifecycle, uiLifecycleSlots.confirmations) === 1,
      );
      const failure = await ui
        .call("windows.recreate", target)
        .catch((error: unknown) => error);
      expect(String(failure)).toContain("CANCELLED");
      expect(await ui.call("windows.getSnapshot", target)).toEqual(before);
      expect(await readFile(resolve(profile, "storage"), "utf8")).toBe(
        "private",
      );
      expect(Atomics.load(ui.lifecycle, uiLifecycleSlots.close)).toBe(0);
      expect(Atomics.load(ui.lifecycle, uiLifecycleSlots.detach)).toBe(0);
      // Forced renderer retirement bypasses the same declined confirmation.
      await ui.call("parser.run", "force-close");
      await ui.waitFor(() => !existsSync(profile));
      for (let tick = 0; tick < 3; tick++) {
        expect(await ui.call("windows.isDestroyed", target)).toBe(true);
      }
      await ui.channel.send({
        kind: "shutdown",
      });
      expect(await ui.exited).toBe(0);
      for (const slot of [
        uiLifecycleSlots.close,
        uiLifecycleSlots.detach,
        uiLifecycleSlots.finish,
        uiLifecycleSlots.destroy,
      ]) {
        expect(Atomics.load(ui.lifecycle, slot)).toBe(1);
      }
    } finally {
      await ui.close();
    }
  },
  timeoutMs + 5_000,
);

test(
  "cancelled last-window quit permits another close without retiring native resources",
  async () => {
    const ui = await startUI(undefined, "ui", undefined, true, {
      closeBehavior: "quit",
    });
    const target = {
      view: "main",
    };
    try {
      await ui.waitFor(() =>
        ui.packets.some((packet) => packet.kind === "ready"),
      );
      await ui.channel.send({
        kind: "start",
      });
      const before = await ui.call("windows.getSnapshot", target);
      await ui.call("parser.run", "user-close");
      await ui.waitFor(() =>
        ui.packets.some((packet) => packet.kind === "quit-request"),
      );
      await ui.channel.send({
        kind: "quit-cancelled",
      });
      // Let the pending close observe cancellation before requesting another close.
      for (let tick = 0; tick < 3; tick++) {
        expect(await ui.call("windows.getSnapshot", target)).toEqual(before);
      }
      expect(Atomics.load(ui.lifecycle, uiLifecycleSlots.close)).toBe(0);
      await ui.call("parser.run", "user-close");
      await ui.waitFor(
        () =>
          ui.packets.filter((packet) => packet.kind === "quit-request")
            .length === 2,
      );
      await ui.channel.send({
        kind: "shutdown",
      });
      expect(await ui.exited).toBe(0);
      expect(Atomics.load(ui.lifecycle, uiLifecycleSlots.close)).toBe(1);
    } finally {
      await ui.close();
    }
  },
  timeoutMs + 5_000,
);

test(
  "successful recreation retains isolated storage and final shutdown releases each native lifetime once",
  async () => {
    const ui = await startUI(undefined, undefined, undefined, true, {
      isolated: true,
    });
    const target = {
      view: "main",
    };
    try {
      await ui.waitFor(() =>
        ui.packets.some((packet) => packet.kind === "ready"),
      );
      await ui.channel.send({
        kind: "start",
      });
      const before = await ui.call("windows.getSnapshot", target);
      const profile = await isolatedProfile(ui);
      await writeFile(resolve(profile, "storage"), "private");
      expect(await ui.call("windows.recreate", target)).toBeNull();
      expect(await ui.call("windows.getSnapshot", target)).not.toEqual(before);
      expect(await isolatedProfile(ui)).toBe(profile);
      expect(await readFile(resolve(profile, "storage"), "utf8")).toBe(
        "private",
      );
      expect(Atomics.load(ui.lifecycle, uiLifecycleSlots.finish)).toBe(1);
      await ui.channel.send({
        kind: "shutdown",
      });
      expect(await ui.exited).toBe(0);
      expect(existsSync(profile)).toBe(false);
      for (const slot of [
        uiLifecycleSlots.close,
        uiLifecycleSlots.detach,
        uiLifecycleSlots.finish,
        uiLifecycleSlots.destroy,
      ]) {
        expect(Atomics.load(ui.lifecycle, slot)).toBe(2);
      }
    } finally {
      await ui.close();
    }
  },
  timeoutMs + 5_000,
);

test.each([
  "controller",
  "constructor",
] as const)(
  "replacement %s failure releases retained storage and permits a fresh isolated creation",
  async (creationFailure) => {
    const ui = await startUI(undefined, undefined, undefined, true, {
      isolated: true,
      failCreationNumber: 2,
      creationFailure,
    });
    const target = {
      view: "main",
    };
    try {
      await ui.waitFor(() =>
        ui.packets.some((packet) => packet.kind === "ready"),
      );
      await ui.channel.send({
        kind: "start",
      });
      const profile = await isolatedProfile(ui);
      await writeFile(resolve(profile, "storage"), "private");
      const failure = await ui
        .call("windows.recreate", target)
        .catch((error: unknown) => error);
      expect(String(failure)).toContain("INTERNAL");
      await ui.waitFor(() => !existsSync(profile));
      expect(await ui.call("windows.listInstances", null)).toEqual([]);
      expect(ui.packets.some((packet) => packet.kind === "fatal")).toBe(false);
      expect(await ui.call("windows.create", target)).toBeNull();
      const fresh = await isolatedProfile(ui);
      expect(fresh).not.toBe(profile);
      expect(existsSync(resolve(fresh, "storage"))).toBe(false);
      await ui.channel.send({
        kind: "shutdown",
      });
      expect(await ui.exited).toBe(0);
      for (const slot of [
        uiLifecycleSlots.close,
        uiLifecycleSlots.detach,
        uiLifecycleSlots.finish,
        uiLifecycleSlots.destroy,
      ]) {
        expect(Atomics.load(ui.lifecycle, slot)).toBe(
          creationFailure === "controller" || slot === uiLifecycleSlots.destroy
            ? 3
            : 2,
        );
      }
    } finally {
      await ui.close();
    }
  },
  timeoutMs + 5_000,
);

test(
  "modal input restoration retries after COM completion without repeating native cleanup",
  async () => {
    const ui = await startUI();
    const main = {
      view: "main",
    };
    try {
      await ui.waitFor(() =>
        ui.packets.some((packet) => packet.kind === "ready"),
      );
      await ui.channel.send({
        kind: "start",
      });
      const parent = validateWindowOutput(
        "windows.listInstances",
        await ui.call("windows.listInstances", null),
      )[0];
      expect(parent).toBeDefined();
      const child = validateWindowOutput(
        "windows.createInstance",
        await ui.call("windows.createInstance", {
          view: "editor",
        }),
      );
      const target = {
        view: child.viewId,
        windowId: child.windowId,
      };
      await ui.call("windows.setParent", {
        ...target,
        parent: parent?.windowId ?? null,
        modal: true,
      });
      expect(await ui.call("windows.isEnabled", main)).toBe(false);
      Atomics.store(ui.lifecycle, uiLifecycleSlots.inputRestoreFailures, 1);
      expect(await ui.call("windows.close", target)).toBe(true);
      await ui.waitFor(
        async () => (await ui.call("windows.isEnabled", main)) === true,
      );
      expect(Atomics.load(ui.lifecycle, uiLifecycleSlots.inputRestores)).toBe(
        2,
      );
      expect(Atomics.load(ui.lifecycle, uiLifecycleSlots.finish)).toBe(1);
      expect(
        ui.packets.some(
          (packet) =>
            packet.kind === "diagnostic" &&
            packet.event === "window-input-restore-retry",
        ),
      ).toBe(true);
      await ui.channel.send({
        kind: "shutdown",
      });
      expect(await ui.exited).toBe(0);
      expect(Atomics.load(ui.lifecycle, uiLifecycleSlots.finish)).toBe(2);
    } finally {
      await ui.close();
    }
  },
  timeoutMs + 5_000,
);

test.each([
  "destroy",
  "shutdown",
] as const)(
  "%s cancels a replacement after native release and deletes its retained profile without repeating cleanup",
  async (action) => {
    const ui = await startUI(undefined, undefined, undefined, true, {
      isolated: true,
      holdProfileReuse: true,
    });
    const target = {
      view: "main",
    };
    const requestId = crypto.randomUUID();
    try {
      await ui.waitFor(() =>
        ui.packets.some((packet) => packet.kind === "ready"),
      );
      await ui.channel.send({
        kind: "start",
      });
      // Keep another live lifetime so destroying the replacement does not commit app shutdown.
      await ui.call("windows.createInstance", {
        view: "editor",
      });
      const profile = await isolatedProfile(ui);
      await ui.channel.send({
        kind: "operation",
        context: "backend" as UIConfig["backendContext"],
        source: "backend",
        requestId,
        call: {
          operation: "windows.recreate",
          payload: target,
        },
      });
      await ui.waitFor(
        () => Atomics.load(ui.lifecycle, uiLifecycleSlots.finish) === 1,
      );
      // Native release completes while the shared environment still prevents profile reuse.
      expect(existsSync(profile)).toBe(true);
      expect(
        ui.packets.some(
          (packet) =>
            packet.kind === "host-response" && packet.requestId === requestId,
        ),
      ).toBe(false);
      if (action === "destroy") {
        expect(await ui.call("windows.destroy", target)).toBe(true);
        await ui.waitFor(() =>
          ui.packets.some(
            (packet) =>
              packet.kind === "host-response" && packet.requestId === requestId,
          ),
        );
        expect(
          ui.packets.find(
            (packet) =>
              packet.kind === "host-response" && packet.requestId === requestId,
          ),
        ).toMatchObject({
          response: {
            kind: "error",
            error: {
              code: "CANCELLED",
            },
          },
        });
        await ui.waitFor(() => !existsSync(profile));
        expect(await ui.call("windows.listInstances", null)).toHaveLength(1);
        expect(Atomics.load(ui.lifecycle, uiLifecycleSlots.finish)).toBe(1);
      }
      await ui.channel.send({
        kind: "shutdown",
      });
      expect(await ui.exited).toBe(0);
      expect(existsSync(profile)).toBe(false);
      for (const slot of [
        uiLifecycleSlots.close,
        uiLifecycleSlots.detach,
        uiLifecycleSlots.finish,
        uiLifecycleSlots.destroy,
      ]) {
        expect(Atomics.load(ui.lifecycle, slot)).toBe(2);
      }
    } finally {
      await ui.close();
    }
  },
  timeoutMs + 5_000,
);

test.each([
  1,
  2,
])(
  "a tray cleanup failure retains its error and continues safe UI cleanup (%i failures)",
  async (trayFailures) => {
    const ui = await startUI(undefined, "ui", trayFailures);
    try {
      await ui.waitFor(() =>
        ui.packets.some((packet) => packet.kind === "ready"),
      );
      await ui.channel.send({
        kind: "shutdown",
      });
      await ui.exited;
      // Retrying successfully still reports the original failure rather than a clean shutdown.
      const error = ui.error();
      expect(error).toBeInstanceOf(Error);
      expect(error?.message).toContain("Injected tray icon cleanup failure");
      expect(Array.from(ui.cleanup)).toEqual([
        2,
        1,
        1,
        1,
        1,
        trayFailures === 1 ? 1 : 0,
      ]);
      expect(ui.packets.some((packet) => packet.kind === "cleaned")).toBe(
        false,
      );
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
  "user-close policy blocks renderer callbacks but forced renderer cleanup retires the HWND",
  async () => {
    const ui = await startUI(undefined, "ui");
    const target = {
      view: "main",
    };
    try {
      await ui.waitFor(() =>
        ui.packets.some((packet) => packet.kind === "ready"),
      );
      await ui.channel.send({
        kind: "start",
      });
      const before = await ui.call("windows.getSnapshot", target);
      await ui.call("windows.setClosable", {
        ...target,
        closable: false,
      });
      expect(await ui.call("windows.isClosable", target)).toBe(false);
      await ui.call("parser.run", "user-close");
      // Additional queued operations advance the actual UI loop after the close callback.
      for (let tick = 0; tick < 3; tick++) {
        expect(await ui.call("windows.isDestroyed", target)).toBe(false);
      }
      expect(await ui.call("windows.getSnapshot", target)).toEqual(before);
      await ui.call("parser.run", "force-close");
      await ui.waitFor(
        async () => (await ui.call("windows.isDestroyed", target)) === true,
      );
      expect(await ui.call("windows.listInstances", null)).toEqual([]);
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

test.each([
  "ui",
  "sync",
] as const)(
  "UI rejects %s native execution when shutdown commits during input parsing",
  async (execution) => {
    const ui = await startUI(undefined, execution);
    try {
      await ui.waitFor(() =>
        ui.packets.some((packet) => packet.kind === "ready"),
      );
      expect(await ui.call("parser.run", "healthy")).toBe("healthy");
      expect(Atomics.load(ui.parsing, parserSlots.executions)).toBe(1);
      const requestId = crypto.randomUUID();
      await ui.channel.send({
        kind: "operation",
        context: "backend" as UIConfig["backendContext"],
        source: "backend",
        requestId,
        call: {
          operation: "parser.run",
          payload: "wait",
        },
      });
      await ui.waitFor(
        () => Atomics.load(ui.parsing, parserSlots.started) === 1,
      );
      // Last-window destruction commits closing locally; deliberately withhold cancel/shutdown packets.
      await ui.call("windows.destroy", {
        view: "main",
      });
      await ui.waitFor(() =>
        ui.packets.some((packet) => packet.kind === "closing"),
      );
      Atomics.store(ui.parsing, parserSlots.released, 1);
      await ui.waitFor(() =>
        ui.packets.some(
          (packet) =>
            packet.kind === "host-response" && packet.requestId === requestId,
        ),
      );
      expect(
        ui.packets.find(
          (packet) =>
            packet.kind === "host-response" && packet.requestId === requestId,
        ),
      ).toMatchObject({
        response: {
          kind: "error",
          error: {
            code: "CANCELLED",
          },
        },
      });
      expect(Atomics.load(ui.parsing, parserSlots.executions)).toBe(1);
      await ui.channel.send({
        kind: "shutdown",
      });
      expect(await ui.exited).toBe(0);
      expect(ui.error()).toBeUndefined();
    } finally {
      await ui.close();
    }
  },
  timeoutMs + 5000,
);

test(
  "configured tray without registration rejects startup and still cleans the host",
  async () => {
    const ui = await startUI(undefined, undefined, undefined, false);
    try {
      await ui.waitFor(() =>
        ui.packets.some((packet) => packet.kind === "fatal"),
      );
      await ui.exited;
      expect(
        ui.packets.find((packet) => packet.kind === "fatal"),
      ).toMatchObject({
        error: {
          code: "UNSUPPORTED",
          message: expect.stringContaining(
            "installing and registering @bunaway/plugin-tray",
          ),
        },
      });
      expect(Atomics.load(ui.cleanup, uiCleanupSlots.tray)).toBe(0);
      expect(Atomics.load(ui.cleanup, uiCleanupSlots.bindings)).toBe(1);
      expect(ui.packets.some((packet) => packet.kind === "ready")).toBe(false);
    } finally {
      await ui.close();
    }
  },
  timeoutMs + 5_000,
);
