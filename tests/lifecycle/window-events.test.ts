import { expect, test } from "bun:test";
import { MessageChannel } from "node:worker_threads";
import {
  type AppDefinition,
  type CommandsOf,
  defineApp,
  type EventsOf,
} from "@bunaway/backend";
import { type Client, createClient } from "@bunaway/client";
import { type CoreSession, createCore } from "@bunaway/core";
import type { WindowSnapshot } from "@bunaway/plugin-api/native";
import {
  validateWindowOutput,
  windowEvents,
  windowsPlugin,
} from "@bunaway/plugin-windows";
import {
  API_LIMITS,
  type HostContext,
  PROTOCOL_VERSION,
  parseMessage,
  type ServerMessage,
  serializeMessage,
  type TransportEvent,
} from "@bunaway/protocol";
import {
  Channel,
  type Route,
  validatePacket,
} from "@bunaway/runtime-bun/worker-channel";
import { windowChanges } from "#native/windows/bun/window-events";

const snapshot: WindowSnapshot = {
  windowId: "window-original",
  viewId: "main",
  revision: 1,
  state: {
    visible: true,
    focused: false,
    minimized: false,
    maximized: false,
    fullscreen: false,
  },
  bounds: {
    x: -100,
    y: 20,
    width: 800,
    height: 600,
    dpi: 144,
  },
};
const payload = {
  ...snapshot,
  changes: [
    "move",
  ],
};
const hello = {
  kind: "hello" as const,
  protocol: PROTOCOL_VERSION,
  features: [],
  buildId: "window-events",
};
const app = defineApp({
  modules: [],
  plugins: [
    windowsPlugin,
  ],
});

const objectApp = {
  commands: {},
  events: {},
  plugins: [
    windowsPlugin,
  ] as const,
} satisfies AppDefinition;

// Object definitions retain plugin event schemas when the plugin list is a tuple.
export function checkObjectAppEventTypes(
  client: Client<CommandsOf<typeof objectApp>, EventsOf<typeof objectApp>>,
) {
  void client.listen(
    "windows.changed",
    (event) => {
      const revision: number = event.payload.revision;
      // @ts-expect-error plugin event payloads retain their concrete field types
      const invalid: string = event.payload.revision;
      void [
        revision,
        invalid,
      ];
    },
    {
      onError() {},
    },
  );
  // @ts-expect-error object definitions do not expose undeclared plugin events
  void client.listen("windows.missing", () => {}, {
    onError() {},
  });
}

test("window changes suppress duplicates and order display state before physical outer geometry", () => {
  expect(windowChanges(snapshot, structuredClone(snapshot))).toEqual([]);
  const minimized = {
    ...snapshot,
    state: {
      ...snapshot.state,
      visible: false,
      minimized: true,
      maximized: false,
    },
    bounds: {
      ...snapshot.bounds,
      x: -32000,
      width: 160,
    },
  };
  expect(
    windowChanges(
      {
        ...snapshot,
        state: {
          ...snapshot.state,
          maximized: true,
          focused: true,
        },
      },
      minimized,
    ),
  ).toEqual([
    "hidden",
    "blur",
    "unmaximize",
    "minimize",
    "move",
    "resize",
  ]);
  expect(
    windowChanges(minimized, {
      ...snapshot,
      state: {
        ...snapshot.state,
        maximized: true,
      },
    }),
  ).toEqual([
    "shown",
    "maximize",
    "restore",
    "move",
    "resize",
  ]);
  expect(
    windowChanges(snapshot, {
      ...snapshot,
      state: {
        ...snapshot.state,
        fullscreen: true,
      },
    }),
  ).toEqual([
    "enterFullscreen",
  ]);
  expect(
    windowChanges(
      {
        ...snapshot,
        state: {
          ...snapshot.state,
          fullscreen: true,
        },
      },
      snapshot,
    ),
  ).toEqual([
    "leaveFullscreen",
  ]);
  expect(
    windowChanges(snapshot, {
      ...snapshot,
      bounds: {
        ...snapshot.bounds,
        dpi: 192,
      },
    }),
  ).toEqual([
    "resize",
  ]);
  expect(validateWindowOutput("windows.getSnapshot", snapshot)).toEqual(
    snapshot,
  );
  expect(() =>
    validateWindowOutput("windows.getSnapshot", {
      ...snapshot,
      revision: -1,
    }),
  ).toThrow();
});

test("typed SDK native subscription validates, denies, releases and isolates recreated sessions", async () => {
  const listeners = new Map<HostContext, (event: TransportEvent) => void>();
  const replies: ServerMessage[] = [];
  const core = await createCore(app, {
    hello,
    platform: "windows",
    backendContext: "backend" as HostContext,
    policy: {
      version: 1,
      backend: {
        permissions: [],
      },
      views: [
        "main",
        "denied",
      ].map((id) => ({
        id,
        origins: [
          "https://app.bunaway.local",
        ],
        commands: [],
        events: id === "main" ? Object.keys(windowEvents) : [],
        host: {
          permissions: [],
        },
      })),
    },
    runtime: {
      createCancellation: () => new AbortController(),
      now: Date.now,
      schedule: (callback, delay) => {
        const timer = setTimeout(callback, delay);
        return () => clearTimeout(timer);
      },
    },
    send: async (context, message) => {
      replies.push(message);
      listeners.get(context)?.({
        kind: "message",
        text: serializeMessage(message),
      });
    },
    callHost: async () => ({
      kind: "result",
      payload: null,
    }),
  });
  function connect(context: HostContext, view: string) {
    const session = core.openSession(context, view);
    const client = createClient<CommandsOf<typeof app>, EventsOf<typeof app>>({
      hello,
      transport: {
        send: async (text) => {
          await session.receive(
            parseMessage(text) as Parameters<CoreSession["receive"]>[0],
          );
        },
        subscribe: (listener) => {
          listeners.set(context, listener);
          return () => {
            listeners.delete(context);
          };
        },
        close: async () => {
          await session.close();
        },
      },
    });
    return {
      client,
      session,
    };
  }
  const context = "ctx-main" as HostContext;
  const original = connect(context, "main");
  const denied = connect("ctx-denied" as HostContext, "denied");
  const seen: number[] = [];
  const failures: unknown[] = [];
  try {
    await Promise.all([
      original.client.ready,
      denied.client.ready,
    ]);
    await expect(
      denied.client.listen("windows.changed", () => {}, {
        onError: () => {},
      }),
    ).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
    const release = await original.client.listen(
      "windows.changed",
      (event) => {
        expect(event.source).toBe("native");
        expect(event.target).toBe("main");
        // Compile-time check: EventsOf includes the registered plugin's concrete payload.
        const revision: number = event.payload.revision;
        seen.push(revision);
      },
      {
        onError: (error) => failures.push(error),
      },
    );
    await expect(
      core.emitNative(context, "windows.changed", {
        ...payload,
        bounds: {
          ...snapshot.bounds,
          dpi: 0,
        },
      }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    await core.emitNative(context, "windows.changed", payload);
    await Bun.sleep(0);
    expect(seen).toEqual([
      1,
    ]);
    await release();
    await core.emitNative(context, "windows.changed", {
      ...payload,
      revision: 2,
    });
    await Bun.sleep(0);
    expect(seen).toEqual([
      1,
    ]);
    await original.client.close();
    const replacementContext = "ctx-recreated" as HostContext;
    const replacement = connect(replacementContext, "main");
    await replacement.client.ready;
    await replacement.client.listen(
      "windows.changed",
      (event) => seen.push(event.payload.revision),
      {
        onError: () => {},
      },
    );
    await core.emitNative(context, "windows.changed", {
      ...payload,
      revision: 3,
    });
    await core.emitNative(replacementContext, "windows.changed", {
      ...payload,
      windowId: "window-new",
      revision: 1,
    });
    await Bun.sleep(0);
    expect(seen).toEqual([
      1,
      1,
    ]);
    await core.stop();
    await core.emitNative(replacementContext, "windows.changed", {
      ...payload,
      revision: 4,
    });
    expect(seen).toEqual([
      1,
      1,
    ]);
    await replacement.client.close();
    expect(failures).toEqual([]);
    expect(
      replies
        .filter((reply) => reply.kind === "event")
        .map((reply) => reply.sequence),
    ).toEqual([
      1,
      1,
    ]);
  } finally {
    await original.client.close();
    await denied.client.close();
    await core.stop();
  }
});

test("native Worker event direction, bounded ingress and independent shutdown capacity", async () => {
  const route: Route = {
    viewId: "main",
    context: "ctx-native" as HostContext,
    documentGeneration: 0,
  };
  const packet = {
    kind: "native-event",
    route,
    event: "windows.changed",
    payload,
  } as const;
  expect(validatePacket(packet, "main")).toEqual(packet);
  expect(() => validatePacket(packet, "ui")).toThrow();
  expect(() =>
    validatePacket(
      {
        ...packet,
        route: undefined,
      },
      "main",
    ),
  ).toThrow();
  const { port1, port2 } = new MessageChannel();
  const channel = new Channel(
    port1,
    {
      id: "native",
      generation: "1",
    },
    "ui",
    () => {},
    () => {},
  );
  const pending: Promise<unknown>[] = [];
  try {
    for (let index = 0; index < API_LIMITS.maxPending; index++) {
      pending.push(channel.send(packet).catch((error: unknown) => error));
    }
    await expect(channel.send(packet)).rejects.toMatchObject({
      code: "BUSY",
    });
    pending.push(
      channel
        .send({
          kind: "closing",
        })
        .catch((error: unknown) => error),
    );
    expect(pending).toHaveLength(API_LIMITS.maxPending + 1);
  } finally {
    channel.close();
    await Promise.all(pending);
    port1.close();
    port2.close();
  }
});

test("native events terminate an overflowing subscription with BUSY and clear queued delivery", async () => {
  const messages: ServerMessage[] = [];
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const context = "ctx-slow" as HostContext;
  const core = await createCore(app, {
    hello,
    platform: "windows",
    backendContext: "backend" as HostContext,
    policy: {
      version: 1,
      backend: {
        permissions: [],
      },
      views: [
        {
          id: "main",
          origins: [
            "https://app.bunaway.local",
          ],
          commands: [],
          events: [
            "windows.changed",
          ],
          host: {
            permissions: [],
          },
        },
      ],
    },
    runtime: {
      createCancellation: () => new AbortController(),
      now: Date.now,
      schedule: (callback, delay) => {
        const timer = setTimeout(callback, delay);
        return () => clearTimeout(timer);
      },
    },
    send: async (_context, message) => {
      messages.push(message);
      if (message.kind === "event") {
        await held;
      }
    },
    callHost: async () => ({
      kind: "result",
      payload: null,
    }),
  });
  const session = core.openSession(context, "main");
  try {
    await session.receive(hello);
    await session.receive({
      kind: "listen",
      protocol: PROTOCOL_VERSION,
      id: "listen-slow",
      event: "windows.changed",
    });
    for (let revision = 1; revision <= API_LIMITS.maxPending + 2; revision++) {
      await core.emitNative(context, "windows.changed", {
        ...payload,
        revision,
      });
    }
    release();
    await Bun.sleep(0);
    const terminal = messages.filter(
      (message) => message.kind === "subscription-error",
    );
    expect(terminal).toHaveLength(1);
    expect(terminal[0]?.error.code).toBe("BUSY");
    const count = messages.filter((message) => message.kind === "event").length;
    await core.emitNative(context, "windows.changed", {
      ...payload,
      revision: 999,
    });
    await Bun.sleep(0);
    expect(messages.filter((message) => message.kind === "event")).toHaveLength(
      count,
    );
    await session.receive({
      kind: "listen",
      protocol: PROTOCOL_VERSION,
      id: "listen-again",
      event: "windows.changed",
    });
    await core.emitNative(context, "windows.changed", {
      ...payload,
      revision: 1000,
    });
    await Bun.sleep(0);
    expect(messages.filter((message) => message.kind === "event")).toHaveLength(
      count + 1,
    );
  } finally {
    release();
    await core.stop();
  }
});
