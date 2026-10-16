import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import tray from "@bunaway/plugin-tray";
import windows, {
  validateWindowOutput,
  windowEvents,
} from "@bunaway/plugin-windows";
import {
  type JsonValue,
  PROTOCOL_VERSION,
  validateValue,
} from "@bunaway/protocol";
import {
  Channel,
  type Packet,
  type UIConfig,
} from "#native/windows/bun/channel";
import {
  releaseSessionEndWait,
  SESSION_END_WAIT_MS,
} from "#native/windows/bun/session-end";
import { writePluginFixture } from "../fixtures/native-worker.ts";
import { windowPermissions } from "../fixtures/window-permissions.ts";
import {
  uiCleanupSlots,
  uiLifecycleSlots,
  uiWebRequestKinds,
} from "../fixtures/windows-ui-cleanup.ts";

const timeoutMs = 10_000;
/** Capacity of the shared buffer carrying one JSON renderer message into the fixture. */
const WEB_MESSAGE_BYTES = 1024;
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
    /**
     * Lets both views listen to `windows.lifecycle`; only `main` is also granted
     * `windows.listInstances`, which the event requires of its recipients.
     */
    lifecycleEvents?: boolean;
    /** Lets both views listen to `windows.closeRequested` and answer it with `windows.respondClose`. */
    closeRequestEvents?: boolean;
    /** Leaves every `listen` unanswered, as while its result is still crossing the channel. */
    withholdListenResult?: boolean;
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
  const webMessage = new Uint8Array(new SharedArrayBuffer(WEB_MESSAGE_BYTES));
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
        events: [
          ...(lifecycleOptions.lifecycleEvents
            ? [
                "windows.lifecycle",
              ]
            : []),
          ...(lifecycleOptions.closeRequestEvents
            ? [
                "windows.closeRequested",
              ]
            : []),
        ],
        host: {
          permissions: [
            ...(lifecycleOptions.lifecycleEvents && id === "main"
              ? [
                  "windows.listInstances",
                ]
              : []),
            ...(lifecycleOptions.closeRequestEvents
              ? [
                  "windows.respondClose",
                ]
              : []),
          ],
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
      webMessage: webMessage.buffer,
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
  /** Whether a delivered `session-end` packet is answered at once; false leaves the UI wait to time out. */
  const sessionEnd = {
    release: true,
  };
  let workerError: Error | undefined;
  const rememberError = (error: unknown) => {
    workerError = error instanceof Error ? error : new Error(String(error));
  };
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
      if (packet.kind === "session-end" && sessionEnd.release) {
        // Stands in for the main thread finishing app cleanup.
        releaseSessionEndWait(packet.release);
      }
      if (packet.kind === "prepare") {
        channel.notify({
          kind: "grant",
          context: packet.context,
          requestId: packet.requestId,
          allowed: true,
        });
      }
      // Stands in for Core: negotiate every opened session and acknowledge each listen.
      if (packet.kind === "session-open") {
        void channel
          .send({
            kind: "server",
            route: packet.route,
            message: {
              kind: "hello",
              protocol: PROTOCOL_VERSION,
              features: [],
              buildId: "ui-lifecycle",
            },
          })
          .catch(rememberError);
      }
      if (
        packet.kind === "client" &&
        packet.message.kind === "listen" &&
        !lifecycleOptions.withholdListenResult
      ) {
        void channel
          .send({
            kind: "server",
            route: packet.route,
            message: {
              kind: "result",
              protocol: PROTOCOL_VERSION,
              id: packet.message.id,
              payload: {
                subscriptionId: `sub-${packet.route.viewId}`,
              },
            },
          })
          .catch(rememberError);
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
  /**
   * Delivers a window message to the UI owner's session handler on the UI thread.
   * Resolves with the handler result (-1 when it ignored the message) once the UI thread returns.
   */
  async function deliverWindowMessage(
    message: number,
    wparam: number,
    lparam: number,
  ) {
    Atomics.store(lifecycle, uiLifecycleSlots.sessionDone, 0);
    Atomics.store(lifecycle, uiLifecycleSlots.sessionMessage, message);
    Atomics.store(lifecycle, uiLifecycleSlots.sessionWparam, wparam);
    Atomics.store(lifecycle, uiLifecycleSlots.sessionLparam, lparam);
    Atomics.store(lifecycle, uiLifecycleSlots.sessionRequest, 1);
    await waitFor(
      () => Atomics.load(lifecycle, uiLifecycleSlots.sessionDone) === 1,
    );
    return Atomics.load(lifecycle, uiLifecycleSlots.sessionResult);
  }
  /**
   * Replays an action into the window `windowId` on the UI thread: document completion, a JSON web
   * message when `message` is given, a navigation, or a non-forced user close (`"close"`). Resolves
   * once the UI thread has handled it.
   */
  async function deliverWebRequest(
    windowId: string,
    message?: JsonValue,
    action: "message" | "navigation" | "close" = "message",
  ) {
    const hwnd = Number(windowId.replace("window-", ""));
    if (message !== undefined) {
      const bytes = new TextEncoder().encode(JSON.stringify(message));
      webMessage.set(bytes);
      Atomics.store(lifecycle, uiLifecycleSlots.webLength, bytes.length);
    }
    Atomics.store(lifecycle, uiLifecycleSlots.webDone, 0);
    let kind: number = uiWebRequestKinds.message;
    if (action === "navigation") {
      kind = uiWebRequestKinds.navigation;
    } else if (action === "close") {
      kind = uiWebRequestKinds.close;
    } else if (message === undefined) {
      kind = uiWebRequestKinds.documentComplete;
    }
    Atomics.store(lifecycle, uiLifecycleSlots.webKind, kind);
    Atomics.store(lifecycle, uiLifecycleSlots.webTarget, hwnd);
    Atomics.store(lifecycle, uiLifecycleSlots.webRequest, 1);
    await waitFor(
      () => Atomics.load(lifecycle, uiLifecycleSlots.webDone) === 1,
    );
  }
  return {
    sessionEnd,
    deliverWindowMessage,
    deliverWebRequest,
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

test(
  "keep-alive reports each transition to zero windows once and never closes the app",
  async () => {
    const ui = await startUI(undefined, "ui");
    const emptyPackets = () =>
      ui.packets.filter((packet) => packet.kind === "windows-empty").length;
    try {
      await ui.waitFor(() =>
        ui.packets.some((packet) => packet.kind === "ready"),
      );
      await ui.channel.send({
        kind: "start",
      });
      // A live window at startup is not an empty transition.
      await ui.call("windows.isVisible", {
        view: "main",
      });
      expect(emptyPackets()).toBe(0);
      await ui.call("parser.run", "user-close");
      await ui.waitFor(() => emptyPackets() === 1);
      // Several more pump turns must not repeat the report for the same transition.
      for (let tick = 0; tick < 3; tick++) {
        expect(
          await ui.call("windows.isDestroyed", {
            view: "main",
          }),
        ).toBe(true);
      }
      expect(emptyPackets()).toBe(1);
      expect(ui.packets.some((packet) => packet.kind === "closing")).toBe(
        false,
      );
      // A window that becomes live again re-arms the report.
      await ui.channel.send({
        kind: "desktop-control",
        action: "show",
      });
      await ui.waitFor(
        async () =>
          (await ui.call("windows.isDestroyed", {
            view: "main",
          })) === false,
      );
      await ui.call("parser.run", "user-close");
      await ui.waitFor(() => emptyPackets() === 2);
      await ui.channel.send({
        kind: "shutdown",
      });
      expect(await ui.exited).toBe(0);
      // Shutdown teardown closes windows but is not a resident transition.
      expect(emptyPackets()).toBe(2);
    } finally {
      await ui.close();
    }
  },
  timeoutMs + 5_000,
);

test(
  "an approved last-window quit does not report empty windows",
  async () => {
    const ui = await startUI(undefined, "ui", undefined, true, {
      closeBehavior: "quit",
    });
    try {
      await ui.waitFor(() =>
        ui.packets.some((packet) => packet.kind === "ready"),
      );
      await ui.channel.send({
        kind: "start",
      });
      await ui.call("parser.run", "user-close");
      await ui.waitFor(() =>
        ui.packets.some((packet) => packet.kind === "quit-request"),
      );
      for (let tick = 0; tick < 3; tick++) {
        await ui.call("windows.isVisible", {
          view: "main",
        });
      }
      await ui.channel.send({
        kind: "shutdown",
      });
      expect(await ui.exited).toBe(0);
      expect(ui.packets.some((packet) => packet.kind === "windows-empty")).toBe(
        false,
      );
      expect(ui.packets.some((packet) => packet.kind === "closing")).toBe(
        false,
      );
    } finally {
      await ui.close();
    }
  },
  timeoutMs + 5_000,
);

test(
  "trusted destruction of the last window closes the app as window-destroyed without an empty report",
  async () => {
    const ui = await startUI();
    try {
      await ui.waitFor(() =>
        ui.packets.some((packet) => packet.kind === "ready"),
      );
      await ui.channel.send({
        kind: "start",
      });
      await ui.call("windows.destroy", {
        view: "main",
      });
      await ui.waitFor(() =>
        ui.packets.some((packet) => packet.kind === "closing"),
      );
      expect(ui.packets.filter((packet) => packet.kind === "closing")).toEqual([
        {
          kind: "closing",
          reason: "window-destroyed",
        },
      ]);
      await ui.channel.send({
        kind: "shutdown",
      });
      expect(await ui.exited).toBe(0);
      expect(ui.packets.some((packet) => packet.kind === "windows-empty")).toBe(
        false,
      );
    } finally {
      await ui.close();
    }
  },
  timeoutMs + 5_000,
);

const WM_QUERYENDSESSION = 0x0011;
const WM_ENDSESSION = 0x0016;
/** A message the session handler does not consume, used as a UI thread round trip. */
const WM_NULL = 0x0000;
const ENDSESSION_LOGOFF = 0x80000000;

test(
  "session messages answer the query, ignore a cancellation and start shutdown once on confirmation",
  async () => {
    const ui = await startUI(undefined, "ui", undefined, true, {
      closeBehavior: "quit",
    });
    const sessionEnds = () =>
      ui.packets.filter((packet) => packet.kind === "session-end");
    try {
      await ui.waitFor(() =>
        ui.packets.some((packet) => packet.kind === "ready"),
      );
      await ui.channel.send({
        kind: "start",
      });
      const { windowId } = validateWindowOutput(
        "windows.getSnapshot",
        await ui.call("windows.getSnapshot", {
          view: "main",
        }),
      );
      expect(
        await ui.deliverWindowMessage(WM_QUERYENDSESSION, 0, ENDSESSION_LOGOFF),
      ).toBe(1);
      expect(
        await ui.deliverWindowMessage(WM_ENDSESSION, 0, ENDSESSION_LOGOFF),
      ).toBe(0);
      expect(sessionEnds()).toEqual([]);
      expect(
        ui.packets.some(
          (packet) =>
            packet.kind === "quit-request" || packet.kind === "closing",
        ),
      ).toBe(false);
      expect(
        await ui.deliverWindowMessage(WM_ENDSESSION, 1, ENDSESSION_LOGOFF),
      ).toBe(0);
      // A repeated broadcast to another window does not start shutdown again.
      expect(
        await ui.deliverWindowMessage(WM_ENDSESSION, 1, ENDSESSION_LOGOFF),
      ).toBe(0);
      expect(sessionEnds()).toHaveLength(1);
      expect(sessionEnds()[0]).toMatchObject({
        flags: {
          logoff: true,
          critical: false,
          closeApp: false,
        },
      });
      // A user close no longer asks the app to quit, because the main thread owns shutdown. Host
      // calls are denied once shutdown is committed, so the close is delivered directly on the UI
      // thread and the settle ticks are non-host round trips.
      await ui.deliverWebRequest(windowId, undefined, "close");
      for (let tick = 0; tick < 3; tick++) {
        expect(await ui.deliverWindowMessage(WM_NULL, 0, 0)).toBe(-1);
      }
      expect(ui.packets.some((packet) => packet.kind === "quit-request")).toBe(
        false,
      );
      expect(ui.packets.some((packet) => packet.kind === "closing")).toBe(
        false,
      );
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

/** `windows.lifecycle` deliveries to one view's session, validated against the public event schema. */
function lifecycleDeliveries(
  packets: Packet[],
  view: string,
  windowId?: string,
) {
  return packets
    .flatMap((packet) =>
      packet.kind === "native-event" &&
      packet.event === "windows.lifecycle" &&
      packet.route.viewId === view
        ? [
            validateValue(windowEvents["windows.lifecycle"], packet.payload),
          ]
        : [],
    )
    .filter((event) => windowId === undefined || event.windowId === windowId);
}

/**
 * Opens a renderer session for the window and listens to `event`.
 * Each step retries until the UI owner has accepted it, because the fixture Core answers
 * asynchronously and a rejected renderer message consumes no request id.
 */
async function listenToLifecycle(
  ui: Awaited<ReturnType<typeof startUI>>,
  view: string,
  windowId: string,
  event = "windows.lifecycle",
) {
  await ui.waitFor(async () => {
    const opened = ui.packets.some(
      (packet) =>
        packet.kind === "session-open" && packet.route.viewId === view,
    );
    const listening = ui.packets.some(
      (packet) =>
        packet.kind === "client" &&
        packet.route.viewId === view &&
        packet.message.kind === "listen" &&
        packet.message.event === event,
    );
    if (listening) {
      return true;
    }
    await ui.deliverWebRequest(
      windowId,
      opened
        ? {
            kind: "listen",
            protocol: PROTOCOL_VERSION,
            id: `listen-${event}`,
            event,
          }
        : {
            kind: "hello",
            protocol: PROTOCOL_VERSION,
            features: [],
            buildId: "ui-lifecycle",
          },
    );
    return false;
  });
}

test(
  "windows.lifecycle reports each phase once and in order to sessions that may list instances, but not during shutdown",
  async () => {
    const ui = await startUI(undefined, undefined, undefined, true, {
      lifecycleEvents: true,
    });
    try {
      await ui.waitFor(() =>
        ui.packets.some((packet) => packet.kind === "ready"),
      );
      await ui.channel.send({
        kind: "start",
      });
      const main = validateWindowOutput(
        "windows.listInstances",
        await ui.call("windows.listInstances", null),
      )[0];
      expect(main).toBeDefined();
      const first = validateWindowOutput(
        "windows.createInstance",
        await ui.call("windows.createInstance", {
          view: "editor",
        }),
      );
      // `main` may list instances; the editor session listens too but lacks that permission.
      await listenToLifecycle(ui, "main", main?.windowId ?? "");
      await listenToLifecycle(ui, "editor", first.windowId);

      const second = validateWindowOutput(
        "windows.createInstance",
        await ui.call("windows.createInstance", {
          view: "editor",
        }),
      );
      await ui.deliverWebRequest(second.windowId);
      // A repeated completion of the same document must not repeat `ready`.
      await ui.deliverWebRequest(second.windowId);
      expect(
        await ui.call("windows.close", {
          view: second.viewId,
          windowId: second.windowId,
        }),
      ).toBe(true);
      await ui.waitFor(
        () =>
          lifecycleDeliveries(ui.packets, "main", second.windowId).length === 4,
      );
      expect(
        lifecycleDeliveries(ui.packets, "main", second.windowId).map(
          (event) => event.phase,
        ),
      ).toEqual([
        "created",
        "ready",
        "closed",
        "destroyed",
      ]);

      // Recreation retires the old windowId and creates a new one.
      const recreated = validateWindowOutput(
        "windows.recreateInstance",
        await ui.call("windows.recreateInstance", {
          view: first.viewId,
          windowId: first.windowId,
        }),
      );
      expect(recreated.windowId).not.toBe(first.windowId);
      await ui.waitFor(
        () =>
          lifecycleDeliveries(ui.packets, "main", first.windowId).length ===
            2 &&
          lifecycleDeliveries(ui.packets, "main", recreated.windowId).length ===
            1,
      );
      expect(
        lifecycleDeliveries(ui.packets, "main", first.windowId).map(
          (event) => event.phase,
        ),
      ).toEqual([
        "closed",
        "destroyed",
      ]);
      expect(
        lifecycleDeliveries(ui.packets, "main", recreated.windowId).map(
          (event) => event.phase,
        ),
      ).toEqual([
        "created",
      ]);
      expect(lifecycleDeliveries(ui.packets, "editor")).toEqual([]);

      const delivered = lifecycleDeliveries(ui.packets, "main").length;
      await ui.channel.send({
        kind: "shutdown",
      });
      expect(await ui.exited).toBe(0);
      expect(lifecycleDeliveries(ui.packets, "main")).toHaveLength(delivered);
    } finally {
      await ui.close();
    }
  },
  timeoutMs + 5_000,
);

test(
  "a window whose WebView controller never becomes ready emits no lifecycle events",
  async () => {
    const ui = await startUI(undefined, undefined, undefined, true, {
      lifecycleEvents: true,
      failCreationNumber: 2,
      creationFailure: "controller",
    });
    try {
      await ui.waitFor(() =>
        ui.packets.some((packet) => packet.kind === "ready"),
      );
      await ui.channel.send({
        kind: "start",
      });
      const main = validateWindowOutput(
        "windows.listInstances",
        await ui.call("windows.listInstances", null),
      )[0];
      await listenToLifecycle(ui, "main", main?.windowId ?? "");
      const failure = await ui
        .call("windows.createInstance", {
          view: "editor",
        })
        .catch((error: unknown) => error);
      expect(String(failure)).toContain("INTERNAL");
      // The failed lifetime is released natively, yet it never announced itself.
      await ui.waitFor(
        () => Atomics.load(ui.lifecycle, uiLifecycleSlots.destroy) === 1,
      );
      await ui.call("windows.listInstances", null);
      expect(lifecycleDeliveries(ui.packets, "main")).toEqual([]);

      // A later successful creation still announces `created` once its controller is ready.
      const created = validateWindowOutput(
        "windows.createInstance",
        await ui.call("windows.createInstance", {
          view: "editor",
        }),
      );
      await ui.waitFor(
        () =>
          lifecycleDeliveries(ui.packets, "main", created.windowId).length >= 1,
      );
      expect(
        lifecycleDeliveries(ui.packets, "main").map((event) => event.phase),
      ).toEqual([
        "created",
      ]);
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

/** `windows.closeRequested` deliveries to the `main` session, validated against the public event schema. */
function closeRequestEvents(packets: Packet[]) {
  return packets.flatMap((packet) =>
    packet.kind === "native-event" &&
    packet.event === "windows.closeRequested" &&
    packet.route.viewId === "main"
      ? [
          validateValue(windowEvents["windows.closeRequested"], packet.payload),
        ]
      : [],
  );
}

/**
 * Starts the UI with `main` open and, unless `subscribe` is false, listening to
 * `windows.closeRequested`. A close confirmation is set and configured to decline, so a shown
 * confirmation both counts in `confirmations` and keeps the window open.
 */
async function startCloseRequestUI(
  options: {
    closeBehavior?: "keep-alive" | "quit";
    subscribe?: boolean;
    withholdListenResult?: boolean;
  } = {},
) {
  const ui = await startUI(undefined, "ui", undefined, true, {
    closeRequestEvents: true,
    withholdListenResult: options.withholdListenResult ?? false,
    closeBehavior: options.closeBehavior ?? "keep-alive",
  });
  const target = {
    view: "main",
  };
  await ui.waitFor(() => ui.packets.some((packet) => packet.kind === "ready"));
  await ui.channel.send({
    kind: "start",
  });
  const { windowId } = validateWindowOutput(
    "windows.getSnapshot",
    await ui.call("windows.getSnapshot", target),
  );
  await ui.call("windows.setCloseConfirmation", {
    ...target,
    message: "Close?",
  });
  Atomics.store(ui.lifecycle, uiLifecycleSlots.confirmClose, 0);
  if (options.subscribe !== false) {
    await listenToLifecycle(ui, "main", windowId, "windows.closeRequested");
  }
  const respond = (requestId: number, allow: boolean) =>
    ui.call("windows.respondClose", {
      ...target,
      requestId,
      allow,
    });
  /**
   * Round trips through the UI owner so that an ignored close request would have been handled.
   * Uses `windows.isDestroyed`, which stays valid after the window is destroyed.
   */
  const settle = async () => {
    for (let tick = 0; tick < 3; tick++) {
      await ui.call("windows.isDestroyed", target);
    }
  };
  const isDestroyed = async () =>
    (await ui.call("windows.isDestroyed", target)) === true;
  return {
    ui,
    windowId,
    respond,
    settle,
    isDestroyed,
  };
}

test(
  "a subscribed user close waits for the app, coalesces repeated closes and skips the target confirmation once allowed",
  async () => {
    const { ui, respond, settle, isDestroyed } = await startCloseRequestUI();
    try {
      await ui.call("parser.run", "user-close");
      await ui.waitFor(() => closeRequestEvents(ui.packets).length === 1);
      // A repeated user close and a public close do not ask again while the request is pending.
      await ui.call("parser.run", "user-close");
      await settle();
      expect(closeRequestEvents(ui.packets)).toHaveLength(1);
      expect(
        String(
          await ui
            .call("windows.close", {
              view: "main",
            })
            .catch((error: unknown) => error),
        ),
      ).toContain("BUSY");

      await respond(1, false);
      await settle();
      expect(await isDestroyed()).toBe(false);
      expect(Atomics.load(ui.lifecycle, uiLifecycleSlots.close)).toBe(0);
      expect(Atomics.load(ui.lifecycle, uiLifecycleSlots.confirmations)).toBe(
        0,
      );
      // An answered request cannot be answered again.
      expect(String(await respond(1, true).catch((error) => error))).toContain(
        "No pending close request.",
      );

      await ui.call("parser.run", "user-close");
      await ui.waitFor(() => closeRequestEvents(ui.packets).length === 2);
      expect(
        closeRequestEvents(ui.packets).map((event) => event.requestId),
      ).toEqual([
        1,
        2,
      ]);
      expect(String(await respond(1, true).catch((error) => error))).toContain(
        "No pending close request.",
      );
      await respond(2, true);
      await ui.waitFor(isDestroyed);
      expect(Atomics.load(ui.lifecycle, uiLifecycleSlots.close)).toBe(1);
      // The app already decided, so the declining confirmation was never shown.
      expect(Atomics.load(ui.lifecycle, uiLifecycleSlots.confirmations)).toBe(
        0,
      );
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
  "a user close without a closeRequested subscription keeps the confirmation path",
  async () => {
    const { ui, settle, isDestroyed } = await startCloseRequestUI({
      subscribe: false,
    });
    try {
      await ui.call("parser.run", "user-close");
      await ui.waitFor(
        () => Atomics.load(ui.lifecycle, uiLifecycleSlots.confirmations) === 1,
      );
      await settle();
      expect(await isDestroyed()).toBe(false);
      expect(closeRequestEvents(ui.packets)).toEqual([]);
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
  "a closeRequested listen that Core has not confirmed does not make the close wait for the app",
  async () => {
    const { ui, settle, isDestroyed } = await startCloseRequestUI({
      withholdListenResult: true,
    });
    try {
      await ui.call("parser.run", "user-close");
      await ui.waitFor(
        () => Atomics.load(ui.lifecycle, uiLifecycleSlots.confirmations) === 1,
      );
      await settle();
      expect(closeRequestEvents(ui.packets)).toEqual([]);
      expect(await isDestroyed()).toBe(false);
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
  "an allowed close of the last window continues to the quit request, and a cancelled quit allows asking again",
  async () => {
    const { ui, respond, settle, isDestroyed } = await startCloseRequestUI({
      closeBehavior: "quit",
    });
    try {
      await ui.call("parser.run", "user-close");
      await ui.waitFor(() => closeRequestEvents(ui.packets).length === 1);
      expect(ui.packets.some((packet) => packet.kind === "quit-request")).toBe(
        false,
      );
      await respond(1, true);
      await ui.waitFor(() =>
        ui.packets.some((packet) => packet.kind === "quit-request"),
      );
      expect(
        ui.packets.filter((packet) => packet.kind === "quit-request"),
      ).toEqual([
        {
          kind: "quit-request",
          reason: "last-window",
        },
      ]);
      await ui.channel.send({
        kind: "quit-cancelled",
      });
      await settle();
      expect(await isDestroyed()).toBe(false);
      expect(Atomics.load(ui.lifecycle, uiLifecycleSlots.confirmations)).toBe(
        0,
      );
      await ui.call("parser.run", "user-close");
      await ui.waitFor(() => closeRequestEvents(ui.packets).length === 2);
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
  "navigating the asked document cancels the pending close request and keeps the window open",
  async () => {
    const { ui, windowId, respond, settle, isDestroyed } =
      await startCloseRequestUI();
    try {
      await ui.call("parser.run", "user-close");
      await ui.waitFor(() => closeRequestEvents(ui.packets).length === 1);
      await ui.deliverWebRequest(windowId, undefined, "navigation");
      await settle();
      expect(await isDestroyed()).toBe(false);
      expect(Atomics.load(ui.lifecycle, uiLifecycleSlots.close)).toBe(0);
      expect(String(await respond(1, true).catch((error) => error))).toContain(
        "No pending close request.",
      );
      await settle();
      expect(await isDestroyed()).toBe(false);
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
  "ending the closeRequested subscription cancels the pending request, keeps the window open and frees later closes",
  async () => {
    const { ui, windowId, respond, settle, isDestroyed } =
      await startCloseRequestUI();
    try {
      await ui.call("parser.run", "user-close");
      await ui.waitFor(() => closeRequestEvents(ui.packets).length === 1);
      // The document stops listening without answering, as when its listener throws.
      await ui.deliverWebRequest(windowId, {
        kind: "unlisten",
        protocol: PROTOCOL_VERSION,
        id: "unlisten-close-requested",
        subscriptionId: "sub-main",
      });
      await settle();
      expect(await isDestroyed()).toBe(false);
      expect(Atomics.load(ui.lifecycle, uiLifecycleSlots.close)).toBe(0);
      expect(Atomics.load(ui.lifecycle, uiLifecycleSlots.confirmations)).toBe(
        0,
      );
      expect(String(await respond(1, true).catch((error) => error))).toContain(
        "No pending close request.",
      );

      // The reservation is released: a new user close is neither ignored as pending nor asked
      // again, and takes the confirmation path of a window without a subscription.
      await ui.call("parser.run", "user-close");
      await ui.waitFor(
        () => Atomics.load(ui.lifecycle, uiLifecycleSlots.confirmations) === 1,
      );
      await settle();
      expect(closeRequestEvents(ui.packets)).toHaveLength(1);
      expect(await isDestroyed()).toBe(false);
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
  "trusted destruction closes a window with a pending close request and ends the wait",
  async () => {
    const { ui, respond, settle, isDestroyed } = await startCloseRequestUI();
    try {
      // Keep another window alive so that destroying `main` does not end the app.
      await ui.call("windows.createInstance", {
        view: "editor",
      });
      await ui.call("parser.run", "user-close");
      await ui.waitFor(() => closeRequestEvents(ui.packets).length === 1);
      await ui.call("windows.destroy", {
        view: "main",
      });
      await settle();
      expect(await isDestroyed()).toBe(true);
      expect(Atomics.load(ui.lifecycle, uiLifecycleSlots.close)).toBe(1);
      // Destruction cancelled the request, so the reservation is gone and the answer is stale.
      expect(String(await respond(1, true).catch((error) => error))).toContain(
        "Window is not open.",
      );
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
  "session end and shutdown end a pending close request without waiting for an answer",
  async () => {
    const { ui } = await startCloseRequestUI();
    try {
      await ui.call("parser.run", "user-close");
      await ui.waitFor(() => closeRequestEvents(ui.packets).length === 1);
      expect(
        await ui.deliverWindowMessage(WM_ENDSESSION, 1, ENDSESSION_LOGOFF),
      ).toBe(0);
      // Session end cancels the question instead of approving it; the main thread owns the teardown,
      // and host calls are cancelled from here on, so only the teardown itself is observable.
      expect(
        ui.packets.filter((packet) => packet.kind === "session-end"),
      ).toHaveLength(1);
      await ui.channel.send({
        kind: "shutdown",
      });
      expect(await ui.exited).toBe(0);
      expect(Atomics.load(ui.lifecycle, uiLifecycleSlots.destroy)).toBe(1);
    } finally {
      await ui.close();
    }
  },
  timeoutMs + 5_000,
);

test(
  "shutdown while a close request is pending completes the window teardown",
  async () => {
    const { ui } = await startCloseRequestUI();
    try {
      await ui.call("parser.run", "user-close");
      await ui.waitFor(() => closeRequestEvents(ui.packets).length === 1);
      await ui.channel.send({
        kind: "shutdown",
      });
      expect(await ui.exited).toBe(0);
      expect(Atomics.load(ui.lifecycle, uiLifecycleSlots.close)).toBe(1);
      expect(Atomics.load(ui.lifecycle, uiLifecycleSlots.destroy)).toBe(1);
    } finally {
      await ui.close();
    }
  },
  timeoutMs + 5_000,
);

test(
  "an unanswered session end releases the window procedure at the wait limit",
  async () => {
    const ui = await startUI();
    ui.sessionEnd.release = false;
    try {
      await ui.waitFor(() =>
        ui.packets.some((packet) => packet.kind === "ready"),
      );
      await ui.channel.send({
        kind: "start",
      });
      const started = performance.now();
      expect(
        await ui.deliverWindowMessage(WM_ENDSESSION, 1, ENDSESSION_LOGOFF),
      ).toBe(0);
      expect(performance.now() - started).toBeGreaterThanOrEqual(
        SESSION_END_WAIT_MS - 100,
      );
      expect(
        ui.packets.some(
          (packet) =>
            packet.kind === "diagnostic" &&
            packet.event === "session-end-wait-finished" &&
            packet.fields.timedOut === true,
        ),
      ).toBe(true);
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
