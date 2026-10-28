import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
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
import { testAppMetadata } from "../fixtures/app-info.ts";
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
    failCreationNumber?: number;
    creationFailure?: "controller" | "constructor";
    /** Withholds the controller completion of this creation until `parser.run` settles it. */
    holdCreationNumber?: number;
    holdProfileReuse?: boolean;
    closeBehavior?: "keep-alive" | "quit" | "hide";
    /**
     * Lets the document listen to `windows.lifecycle` and grants it
     * `windows.getSnapshot`, which the event requires of its recipients.
     */
    lifecycleEvents?: boolean;
    /** Lets the document listen to `windows.closeRequested` and answer it with `windows.respondClose`. */
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
        home: "https://app.bunaway.local",
        window: {
          width: 800,
          height: 600,
        },
      },
    ],
    policy: {
      version: 1,
      views: [
        "main",
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
            ...(lifecycleOptions.lifecycleEvents
              ? [
                  "windows.getSnapshot",
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
    import { Tray, requestFixtureClose, settleHeldController, hasHeldController } from ${JSON.stringify(resolve(import.meta.dir, "../fixtures/windows-ui-platform.ts"))};
    import { defineNativePlugin } from ${JSON.stringify(resolve(import.meta.dir, "../../packages/plugin-sdk/src/index.ts"))};
    import { z } from ${JSON.stringify(Bun.resolveSync("zod", import.meta.dir))};
    const state = new Int32Array(workerData.parsing);
    const slots = ${JSON.stringify(parserSlots)};
    const cleanup = new Int32Array(workerData.cleanup);
    const cleanupSlots = ${JSON.stringify(uiCleanupSlots)};
    const execute = (_name,input) => {
      Atomics.add(state,slots.executions,1);
      if(input === "user-close" || input === "force-close") requestFixtureClose("main", input === "force-close");
      if(input === "held-controller") return hasHeldController() ? "held" : "none";
      if(input === "ready-held" || input === "fail-held") return settleHeldController(input === "ready-held" ? "ready" : "fail") ? "settled" : "none";
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
      holdCreationNumber: lifecycleOptions.holdCreationNumber,
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

test(
  "declined user close and recreation preserve the live lifetime",
  async () => {
    const ui = await startUI(undefined, "ui", undefined, true);
    const target = null;
    try {
      await ui.waitFor(() =>
        ui.packets.some((packet) => packet.kind === "ready"),
      );
      await ui.channel.send({
        kind: "start",
      });
      const before = await ui.call("windows.getSnapshot", target);
      await ui.call("windows.setCloseConfirmation", {
        message: "Close?",
      });
      Atomics.store(ui.lifecycle, uiLifecycleSlots.confirmClose, 0);
      await ui.call("parser.run", "user-close");
      await ui.waitFor(
        () => Atomics.load(ui.lifecycle, uiLifecycleSlots.confirmations) === 1,
      );
      const failure = await ui
        .call("windows.recreate", {})
        .catch((error: unknown) => error);
      expect(String(failure)).toContain("CANCELLED");
      expect(await ui.call("windows.getSnapshot", target)).toEqual(before);
      expect(Atomics.load(ui.lifecycle, uiLifecycleSlots.close)).toBe(0);
      expect(Atomics.load(ui.lifecycle, uiLifecycleSlots.detach)).toBe(0);
      // Forced renderer retirement bypasses the same declined confirmation.
      await ui.call("parser.run", "force-close");
      await ui.waitFor(async () => !(await ui.call("windows.isOpen", null)));
      for (let tick = 0; tick < 3; tick++) {
        expect(await ui.call("windows.isOpen", null)).toBe(false);
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
    const target = null;
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
    const target = null;
    try {
      await ui.waitFor(() =>
        ui.packets.some((packet) => packet.kind === "ready"),
      );
      await ui.channel.send({
        kind: "start",
      });
      const before = await ui.call("windows.getSnapshot", target);
      await ui.call("windows.setClosable", {
        closable: false,
      });
      expect(await ui.call("windows.isClosable", target)).toBe(false);
      await ui.call("parser.run", "user-close");
      // Additional queued operations advance the actual UI loop after the close callback.
      for (let tick = 0; tick < 3; tick++) {
        expect(await ui.call("windows.isOpen", null)).toBe(true);
      }
      expect(await ui.call("windows.getSnapshot", target)).toEqual(before);
      await ui.call("parser.run", "force-close");
      await ui.waitFor(async () => !(await ui.call("windows.isOpen", null)));
      expect(await ui.call("windows.isOpen", null)).toBe(false);
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
  "desktop Open shows the live window without creating another lifetime",
  async () => {
    const ui = await startUI();
    try {
      await ui.waitFor(() =>
        ui.packets.some((packet) => packet.kind === "ready"),
      );
      await ui.channel.send({
        kind: "start",
      });
      const identity = validateWindowOutput(
        "windows.getReadiness",
        await ui.call("windows.getReadiness", null),
      );
      for (const action of [
        "hide",
        "show",
      ] as const) {
        await ui.channel.send({
          kind: "desktop-control",
          action,
        });
        // Desktop control is queued for the UI pump; wait for its observable effect.
        await ui.waitFor(
          async () =>
            (await ui.call("windows.isVisible", null)) === (action === "show"),
        );
        expect(await ui.call("windows.isVisible", null)).toBe(
          action === "show",
        );
      }
      expect(
        validateWindowOutput(
          "windows.getReadiness",
          await ui.call("windows.getReadiness", null),
        ).windowId,
      ).toBe(identity.windowId);
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
      await ui.call("windows.destroy", null);
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
      await ui.call("windows.isVisible", null);
      expect(emptyPackets()).toBe(0);
      await ui.call("parser.run", "user-close");
      await ui.waitFor(() => emptyPackets() === 1);
      // Several more pump turns must not repeat the report for the same transition.
      for (let tick = 0; tick < 3; tick++) {
        expect(await ui.call("windows.isOpen", null)).toBe(false);
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
        async () => (await ui.call("windows.isOpen", null)) === true,
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
        await ui.call("windows.isVisible", null);
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
      await ui.call("windows.destroy", null);
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

test(
  "a window still being created neither counts as live for the empty report nor re-arms it when creation fails",
  async () => {
    const ui = await startUI(undefined, "ui", undefined, true, {
      holdCreationNumber: 2,
    });
    const emptyPackets = () =>
      ui.packets.filter((packet) => packet.kind === "windows-empty").length;
    try {
      await ui.waitFor(() =>
        ui.packets.some((packet) => packet.kind === "ready"),
      );
      await ui.channel.send({
        kind: "start",
      });
      // The only created window closes: the app is empty.
      await ui.call("parser.run", "user-close");
      await ui.waitFor(() => emptyPackets() === 1);
      // The next window's controller stays pending, so its creation call stays open.
      const creation = ui
        .call("windows.create", {})
        .catch((error: unknown) => error);
      await ui.waitFor(
        async () => (await ui.call("parser.run", "held-controller")) === "held",
      );
      // Creation fails before `created`; the creating window never counted, so nothing is re-armed.
      expect(await ui.call("parser.run", "fail-held")).toBe("settled");
      expect(String(await creation)).toContain("INTERNAL");
      for (let tick = 0; tick < 3; tick++) {
        await ui.call("windows.isOpen", null);
      }
      expect(emptyPackets()).toBe(1);
      await ui.channel.send({
        kind: "shutdown",
      });
      expect(await ui.exited).toBe(0);
      expect(emptyPackets()).toBe(1);
    } finally {
      await ui.close();
    }
  },
  timeoutMs + 5_000,
);

test(
  "a window counts as live once its controller is ready, so closing it reports empty again",
  async () => {
    const ui = await startUI(undefined, "ui", undefined, true, {
      holdCreationNumber: 2,
    });
    const emptyPackets = () =>
      ui.packets.filter((packet) => packet.kind === "windows-empty").length;
    try {
      await ui.waitFor(() =>
        ui.packets.some((packet) => packet.kind === "ready"),
      );
      await ui.channel.send({
        kind: "start",
      });
      await ui.call("parser.run", "user-close");
      await ui.waitFor(() => emptyPackets() === 1);
      const creation = ui.call("windows.create", {});
      await ui.waitFor(
        async () => (await ui.call("parser.run", "held-controller")) === "held",
      );
      expect(await ui.call("parser.run", "ready-held")).toBe("settled");
      await creation;
      // The ready window is live again, so its close is a new transition to zero windows.
      expect(await ui.call("windows.close", null)).toBe(true);
      await ui.waitFor(() => emptyPackets() === 2);
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
  "recreating the only keep-alive window does not report empty while the replacement is being created",
  async () => {
    const ui = await startUI(undefined, "ui", undefined, true, {
      holdCreationNumber: 2,
    });
    const emptyPackets = () =>
      ui.packets.filter((packet) => packet.kind === "windows-empty").length;
    try {
      await ui.waitFor(() =>
        ui.packets.some((packet) => packet.kind === "ready"),
      );
      await ui.channel.send({
        kind: "start",
      });
      // The replacement's controller stays pending: the old window is closed and none is ready yet.
      const recreation = ui.call("windows.recreate", {});
      await ui.waitFor(
        async () => (await ui.call("parser.run", "held-controller")) === "held",
      );
      for (let tick = 0; tick < 3; tick++) {
        await ui.call("parser.run", "held-controller");
      }
      expect(emptyPackets()).toBe(0);
      expect(await ui.call("parser.run", "ready-held")).toBe("settled");
      await recreation;
      for (let tick = 0; tick < 3; tick++) {
        await ui.call("parser.run", "held-controller");
      }
      expect(emptyPackets()).toBe(0);
      await ui.channel.send({
        kind: "shutdown",
      });
      expect(await ui.exited).toBe(0);
      expect(emptyPackets()).toBe(0);
    } finally {
      await ui.close();
    }
  },
  timeoutMs + 5_000,
);

test(
  "a failed replacement of the only keep-alive window reports empty exactly once",
  async () => {
    const ui = await startUI(undefined, "ui", undefined, true, {
      holdCreationNumber: 2,
    });
    const emptyPackets = () =>
      ui.packets.filter((packet) => packet.kind === "windows-empty").length;
    try {
      await ui.waitFor(() =>
        ui.packets.some((packet) => packet.kind === "ready"),
      );
      await ui.channel.send({
        kind: "start",
      });
      const recreation = ui
        .call("windows.recreate", {})
        .catch((error: unknown) => error);
      await ui.waitFor(
        async () => (await ui.call("parser.run", "held-controller")) === "held",
      );
      expect(emptyPackets()).toBe(0);
      expect(await ui.call("parser.run", "fail-held")).toBe("settled");
      await recreation;
      await ui.waitFor(() => emptyPackets() === 1);
      for (let tick = 0; tick < 3; tick++) {
        await ui.call("parser.run", "held-controller");
      }
      expect(emptyPackets()).toBe(1);
      await ui.channel.send({
        kind: "shutdown",
      });
      expect(await ui.exited).toBe(0);
      expect(emptyPackets()).toBe(1);
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
        await ui.call("windows.getSnapshot", null),
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

/** Reads the next published phase after `after` through the backend subscription. */
async function nextLifecycle(
  ui: Awaited<ReturnType<typeof startUI>>,
  after: number,
) {
  return validateWindowOutput(
    "windows.waitForLifecycle",
    await ui.call("windows.waitForLifecycle", {
      after,
    }),
  );
}

test(
  "windows.waitForLifecycle reports each phase once and in order, and nothing during shutdown",
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
      const first = validateWindowOutput(
        "windows.getReadiness",
        await ui.call("windows.getReadiness", null),
      );
      await listenToLifecycle(ui, "main", first.windowId);
      // A repeated completion of the same document must not repeat `ready`.
      await ui.deliverWebRequest(first.windowId);
      // Recreation retires the old windowId and creates a new one.
      await ui.call("windows.recreate", {});
      const seen: {
        windowId: string;
        phase: string;
      }[] = [];
      let after = 0;
      while (seen.length < 5) {
        const event = await nextLifecycle(ui, after);
        after = event.sequence;
        seen.push({
          windowId: event.windowId,
          phase: event.phase,
        });
      }
      expect(seen.map((event) => event.phase)).toEqual([
        "created",
        "ready",
        "closed",
        "destroyed",
        "created",
      ]);
      expect(seen.slice(0, 4).every((e) => e.windowId === first.windowId)).toBe(
        true,
      );
      expect(seen[4]?.windowId).not.toBe(first.windowId);

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
      const first = await nextLifecycle(ui, 0);
      expect(first.phase).toBe("created");
      const failure = await ui
        .call("windows.recreate", {})
        .catch((error: unknown) => error);
      expect(String(failure)).toContain("INTERNAL");
      // The failed lifetime is released natively, yet it never announced itself.
      await ui.waitFor(
        () => Atomics.load(ui.lifecycle, uiLifecycleSlots.destroy) === 2,
      );
      const closed = await nextLifecycle(ui, first.sequence);
      const destroyed = await nextLifecycle(ui, closed.sequence);
      expect([
        closed.phase,
        destroyed.phase,
      ]).toEqual([
        "closed",
        "destroyed",
      ]);
      expect(closed.windowId).toBe(first.windowId);
      expect(destroyed.windowId).toBe(first.windowId);

      // A later successful creation still announces `created` once its controller is ready.
      await ui.call("windows.create", {});
      const created = await nextLifecycle(ui, destroyed.sequence);
      expect(created.phase).toBe("created");
      expect(created.windowId).not.toBe(first.windowId);
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
    closeBehavior?: "keep-alive" | "quit" | "hide";
    subscribe?: boolean;
    withholdListenResult?: boolean;
  } = {},
) {
  const ui = await startUI(undefined, "ui", undefined, true, {
    closeRequestEvents: true,
    withholdListenResult: options.withholdListenResult ?? false,
    closeBehavior: options.closeBehavior ?? "keep-alive",
  });
  const target = null;
  await ui.waitFor(() => ui.packets.some((packet) => packet.kind === "ready"));
  await ui.channel.send({
    kind: "start",
  });
  const { windowId } = validateWindowOutput(
    "windows.getSnapshot",
    await ui.call("windows.getSnapshot", target),
  );
  await ui.call("windows.setCloseConfirmation", {
    message: "Close?",
  });
  Atomics.store(ui.lifecycle, uiLifecycleSlots.confirmClose, 0);
  if (options.subscribe !== false) {
    await listenToLifecycle(ui, "main", windowId, "windows.closeRequested");
  }
  const respond = (requestId: number, allow: boolean) =>
    ui.call("windows.respondClose", {
      requestId,
      allow,
    });
  /**
   * Round trips through the UI owner so that an ignored close request would have been handled.
   * Uses `windows.isOpen`, which stays valid after the window is destroyed.
   */
  const settle = async () => {
    for (let tick = 0; tick < 3; tick++) {
      await ui.call("windows.isOpen", null);
    }
  };
  const isDestroyed = async () => !(await ui.call("windows.isOpen", null));
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
          await ui.call("windows.close", null).catch((error: unknown) => error),
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
    const { ui } = await startCloseRequestUI();
    try {
      await ui.call("parser.run", "user-close");
      await ui.waitFor(() => closeRequestEvents(ui.packets).length === 1);
      await ui.call("windows.destroy", null);
      // Destruction of the only window ends the app and cancels the pending request.
      await ui.waitFor(() =>
        ui.packets.some((packet) => packet.kind === "closing"),
      );
      expect(Atomics.load(ui.lifecycle, uiLifecycleSlots.close)).toBe(1);
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
  "shutdown-committed cancels the pending close request and stops new ones",
  async () => {
    const { ui, windowId } = await startCloseRequestUI();
    // Host calls are denied once shutdown is committed, so UI thread round trips stand in for settling.
    const settleUI = async () => {
      for (let tick = 0; tick < 5; tick++) {
        await ui.deliverWindowMessage(WM_NULL, 0, 0);
      }
    };
    try {
      await ui.call("parser.run", "user-close");
      await ui.waitFor(() => closeRequestEvents(ui.packets).length === 1);
      // The main thread approved a quit that the UI did not report itself.
      await ui.channel.send({
        kind: "shutdown-committed",
      });
      await settleUI();
      // The pending question was cancelled, which keeps the window open.
      expect(Atomics.load(ui.lifecycle, uiLifecycleSlots.close)).toBe(0);
      // Another close ends in the confirmation path instead of asking the app again.
      await ui.deliverWebRequest(windowId, undefined, "close");
      await ui.waitFor(
        () => Atomics.load(ui.lifecycle, uiLifecycleSlots.confirmations) === 1,
      );
      await settleUI();
      expect(closeRequestEvents(ui.packets)).toHaveLength(1);
      expect(ui.packets.some((packet) => packet.kind === "quit-request")).toBe(
        false,
      );
      // The commit is idempotent, and the UI never reports a shutdown the main thread already owns.
      await ui.channel.send({
        kind: "shutdown-committed",
      });
      await settleUI();
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

test(
  "windows.lifecycle is not emitted once the main thread committed shutdown",
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
        "windows.getReadiness",
        await ui.call("windows.getReadiness", null),
      );
      await listenToLifecycle(ui, "main", main.windowId);
      const created = await nextLifecycle(ui, 0);
      expect(created.phase).toBe("created");
      const delivered = lifecycleDeliveries(ui.packets, "main").length;
      await ui.channel.send({
        kind: "shutdown-committed",
      });
      const pending = ui
        .call("windows.waitForLifecycle", {
          after: created.sequence,
        })
        .catch((error: unknown) => error);
      // Host calls are not needed: the renderer closes the window directly on the UI thread.
      await ui.deliverWebRequest(main.windowId, undefined, "close");
      for (let tick = 0; tick < 5; tick++) {
        await ui.deliverWindowMessage(WM_NULL, 0, 0);
      }
      const outcome = await Promise.race([
        pending.then(() => "settled"),
        Bun.sleep(200).then(() => "waiting"),
      ]);
      expect(lifecycleDeliveries(ui.packets, "main")).toHaveLength(delivered);
      await ui.channel.send({
        kind: "shutdown",
      });
      expect(await ui.exited).toBe(0);
      expect(lifecycleDeliveries(ui.packets, "main")).toHaveLength(delivered);
      // Only the first retained phase may be answered; the later ones were never published.
      expect([
        "waiting",
        "settled",
      ]).toContain(outcome);
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
  "closeBehavior hide hides a user close to the tray without a confirmation or retirement",
  async () => {
    const { ui, windowId, settle, isDestroyed } = await startCloseRequestUI({
      closeBehavior: "hide",
      subscribe: false,
    });
    void windowId;
    try {
      expect(await ui.call("windows.isVisible", null)).toBe(true);
      await ui.call("parser.run", "user-close");
      await ui.waitFor(
        async () => (await ui.call("windows.isVisible", null)) === false,
      );
      await settle();
      expect(await isDestroyed()).toBe(false);
      expect(Atomics.load(ui.lifecycle, uiLifecycleSlots.confirmations)).toBe(
        0,
      );
      expect(Atomics.load(ui.lifecycle, uiLifecycleSlots.close)).toBe(0);
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
  "a close requested while the app still decides an earlier close is rejected as pending",
  async () => {
    const { ui, respond, settle, isDestroyed } = await startCloseRequestUI();
    try {
      await ui.call("parser.run", "user-close");
      await ui.waitFor(() => closeRequestEvents(ui.packets).length === 1);
      const failure = await ui
        .call("windows.close", null)
        .catch((error: unknown) => error);
      expect(String(failure)).toContain("Window close is already pending.");
      await settle();
      expect(await isDestroyed()).toBe(false);
      // The original request is still answerable and the allowed close then completes.
      await respond(1, true);
      await ui.waitFor(isDestroyed);
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
      // The diagnostic travels as a channel message, so it can arrive after the UI thread has
      // already reported the handler as done; wait for it instead of reading the list at once.
      const waitFinished = () =>
        ui.packets.find(
          (packet) =>
            packet.kind === "diagnostic" &&
            packet.event === "session-end-wait-finished",
        );
      await ui.waitFor(() => waitFinished() !== undefined);
      expect(waitFinished()).toMatchObject({
        fields: {
          timedOut: true,
        },
      });
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
  "a plugin event relayed from the I/O Worker reaches only subscribed views, and the operation gate still applies",
  async () => {
    const { ui, settle } = await startCloseRequestUI();
    try {
      const delivered = (event: string) =>
        ui.packets.filter(
          (packet) => packet.kind === "native-event" && packet.event === event,
        );
      const relay = (
        event: string,
        requiredOperation: string | null,
        payload: number,
      ) =>
        ui.channel.send({
          kind: "plugin-event",
          event,
          payload,
          requiredOperation,
          dropped: 0,
        });
      // The view listens to windows.closeRequested only; a name nobody listens to goes nowhere.
      await relay("windows.closeRequested", null, 1);
      await relay("probe.changed", null, 2);
      // An operation the registry does not know is refused before any view is checked.
      await relay("windows.closeRequested", "unknown.read", 3);
      await settle();
      await ui.waitFor(() => delivered("windows.closeRequested").length === 1);
      expect(delivered("windows.closeRequested")).toMatchObject([
        {
          payload: 1,
        },
      ]);
      expect(delivered("probe.changed")).toHaveLength(0);
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
