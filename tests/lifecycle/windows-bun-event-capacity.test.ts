import { expect, test } from "bun:test";
import { MessageChannel } from "node:worker_threads";
import { Channel, type Packet, type Route } from "#native/windows/bun/channel";
import { command } from "#backend/command";
import {
  type Core,
  type CoreSession,
  createCore,
  type EventEmitter,
} from "@bunaway/core";
import {
  API_LIMITS,
  type HostContext,
  type JsonValue,
  PROTOCOL_VERSION,
} from "@bunaway/protocol";

type ServerPacket = Extract<
  Packet,
  {
    kind: "server";
  }
>;

const SUBSCRIPTIONS_PER_VIEW = 65;
const runtime = {
  id: "event-capacity",
  generation: "1",
};
const hello = {
  kind: "hello" as const,
  protocol: PROTOCOL_VERSION,
  features: [],
  buildId: "event-capacity-test",
};

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error("Event capacity test did not complete.");
    }
    await Bun.sleep(1);
  }
}

/** Connect two views to a Core and optionally hold event acknowledgements. */
async function eventHarness() {
  const { port1, port2 } = new MessageChannel();
  const failures: unknown[] = [];
  const servers: ServerPacket[] = [];
  const controls: Packet[] = [];
  const routes: Route[] = [
    "editor",
    "reader",
  ].map((viewId) => ({
    viewId,
    documentGeneration: 0,
    // The test adapter acts as the trusted host that issues session contexts.
    context: `ctx-${viewId}` as HostContext,
  }));
  const sessions = new Map<HostContext, CoreSession>();
  let core: Core | undefined;
  let emitter: EventEmitter | undefined;
  let holdEvents = false;
  let releaseAcknowledgements = () => {};
  const held = new Promise<void>((resolve) => {
    releaseAcknowledgements = resolve;
  });
  const main = new Channel(
    port1,
    runtime,
    "main",
    async (packet) => {
      if (packet.kind === "session-open") {
        if (!core) {
          throw new Error("Core is not initialized.");
        }
        sessions.set(
          packet.route.context,
          core.openSession(packet.route.context, packet.route.viewId),
        );
      } else if (packet.kind === "client") {
        const session = sessions.get(packet.route.context);
        if (!session) {
          throw new Error("Missing Core session.");
        }
        await session.receive(packet.message);
      }
    },
    (error) => failures.push(error),
  );
  const ui = new Channel(
    port2,
    runtime,
    "ui",
    (packet) => {
      if (packet.kind !== "server") {
        controls.push(packet);
        return;
      }
      servers.push(packet);
      if (holdEvents && packet.message.kind === "event") {
        return held;
      }
    },
    (error) => failures.push(error),
  );
  const initializedCore = await createCore(
    {
      commands: {
        echo: command({
          input: {
            type: "string",
          },
          output: {
            type: "string",
          },
          handle: (input) => input,
        }),
      },
      events: {
        changed: {},
      },
      plugins: [
        {
          name: "event-emitter",
          version: "1",
          setup(context) {
            emitter = context.events;
          },
        },
      ],
    },
    {
      hello,
      policy: {
        version: 1,
        views: routes.map((route) => ({
          id: route.viewId,
          origins: [
            "https://app.bunaway.local",
          ],
          commands: [
            "echo",
          ],
          events: [
            "changed",
          ],
          host: {
            permissions: [],
          },
        })),
        backend: {
          permissions: [],
        },
      },
      platform: "windows",
      backendContext: "backend-event-capacity" as HostContext,
      runtime: {
        createCancellation: () => new AbortController(),
        now: Date.now,
        schedule: (callback, delay) => {
          const timer = setTimeout(callback, delay);
          return () => clearTimeout(timer);
        },
      },
      send: async (context, message) => {
        const route = routes.find((candidate) => candidate.context === context);
        if (!route) {
          throw new Error("Missing server route.");
        }
        await main.send({
          kind: "server",
          route,
          message,
        });
      },
      callHost: async () => ({
        kind: "result",
        payload: null,
      }),
    },
  );
  core = initializedCore;
  const releaseEvents = () => {
    holdEvents = false;
    releaseAcknowledgements();
  };
  return {
    main,
    ui,
    routes,
    failures,
    servers,
    controls,
    holdEvents: () => {
      holdEvents = true;
    },
    releaseEvents,
    async emit(payload: JsonValue) {
      if (!emitter) {
        throw new Error("Missing backend event emitter.");
      }
      await emitter.emit("changed", payload, {
        kind: "broadcast",
      });
    },
    async subscribe() {
      for (const route of routes) {
        await ui.send({
          kind: "session-open",
          route,
        });
        await ui.send({
          kind: "client",
          route,
          message: hello,
        });
        await Promise.all(
          Array.from(
            {
              length: SUBSCRIPTIONS_PER_VIEW,
            },
            (_, index) =>
              ui.send({
                kind: "client",
                route,
                message: {
                  kind: "listen",
                  protocol: PROTOCOL_VERSION,
                  id: `listen-${index}`,
                  event: "changed",
                },
              }),
          ),
        );
        await main.drain();
        await ui.drain();
      }
    },
    async close() {
      releaseEvents();
      await initializedCore.stop();
      main.close();
      ui.close();
      port1.close();
      port2.close();
    },
  };
}

type EventHarness = Awaited<ReturnType<typeof eventHarness>>;

async function echoAfterEvents(harness: EventHarness): Promise<void> {
  const route = harness.routes[0];
  if (!route) {
    throw new Error("Missing command route.");
  }
  await harness.ui.send({
    kind: "client",
    route,
    message: {
      kind: "invoke",
      protocol: PROTOCOL_VERSION,
      id: "after-events",
      command: "echo",
      payload: "host-still-live",
    },
  });
  await waitFor(() =>
    harness.servers.some(
      ({ message }) =>
        message.kind === "result" && message.id === "after-events",
    ),
  );
  expect(
    harness.servers.find(
      ({ message }) =>
        message.kind === "result" && message.id === "after-events",
    )?.message,
  ).toMatchObject({
    kind: "result",
    payload: "host-still-live",
  });
}

test("backend broadcasts reach every subscription across views beyond one channel data burst", async () => {
  const harness = await eventHarness();
  const subscriptions = harness.routes.length * SUBSCRIPTIONS_PER_VIEW;
  try {
    await harness.subscribe();
    for (let broadcast = 1; broadcast <= 3; broadcast++) {
      await harness.emit(broadcast);
      await waitFor(
        () =>
          harness.servers.filter(({ message }) => message.kind === "event")
            .length ===
          broadcast * subscriptions,
      );
      await harness.main.drain();
    }
    for (const route of harness.routes) {
      for (let index = 1; index <= SUBSCRIPTIONS_PER_VIEW; index++) {
        const deliveries = harness.servers.filter(
          (packet) =>
            packet.route.context === route.context &&
            packet.message.kind === "event" &&
            packet.message.subscriptionId === `sub-${index}`,
        );
        expect(deliveries.map(({ message }) => message)).toMatchObject([
          {
            sequence: 1,
            payload: 1,
            source: "backend",
            target: route.viewId,
          },
          {
            sequence: 2,
            payload: 2,
            source: "backend",
            target: route.viewId,
          },
          {
            sequence: 3,
            payload: 3,
            source: "backend",
            target: route.viewId,
          },
        ]);
      }
    }
    expect(
      harness.servers.some(
        ({ message }) => message.kind === "subscription-error",
      ),
    ).toBe(false);
    await echoAfterEvents(harness);
    expect(harness.failures).toEqual([]);
  } finally {
    await harness.close();
  }
});

test("slow event acknowledgements end overflowing subscriptions with BUSY and preserve control capacity", async () => {
  const harness = await eventHarness();
  const subscriptions = harness.routes.length * SUBSCRIPTIONS_PER_VIEW;
  try {
    await harness.subscribe();
    harness.holdEvents();
    await harness.emit("first");
    await waitFor(
      () =>
        harness.servers.filter(({ message }) => message.kind === "event")
          .length === API_LIMITS.maxPending,
    );
    expect(harness.main.canSend()).toBe(false);
    // Each subscription's first send is waiting for an ACK. Its own queue
    // overflows independently of the shared channel's retained server sends.
    for (let index = 0; index <= API_LIMITS.maxPending; index++) {
      await harness.emit(index);
    }
    expect(
      harness.servers.some(
        ({ message }) => message.kind === "subscription-error",
      ),
    ).toBe(false);
    const route = harness.routes[0];
    if (!route) {
      throw new Error("Missing control context.");
    }
    await Promise.all([
      harness.main.send({
        kind: "cancel",
        context: route.context,
        requestId: "held-host-operation",
      }),
      harness.main.send({
        kind: "shutdown",
      }),
    ]);
    expect(harness.controls.map((packet) => packet.kind)).toEqual([
      "cancel",
      "shutdown",
    ]);
    harness.releaseEvents();
    await waitFor(
      () =>
        harness.servers.filter(
          ({ message }) => message.kind === "subscription-error",
        ).length === subscriptions,
    );
    await harness.main.drain();
    for (const route of harness.routes) {
      for (let index = 1; index <= SUBSCRIPTIONS_PER_VIEW; index++) {
        const deliveries = harness.servers.filter(
          (packet) =>
            packet.route.context === route.context &&
            (packet.message.kind === "event" ||
              packet.message.kind === "subscription-error") &&
            packet.message.subscriptionId === `sub-${index}`,
        );
        expect(deliveries.map(({ message }) => message)).toMatchObject([
          {
            kind: "event",
            sequence: 1,
            payload: "first",
          },
          {
            kind: "subscription-error",
            error: {
              code: "BUSY",
              message: "Subscription queue full.",
            },
          },
        ]);
      }
    }
    await harness.emit("after-overflow");
    await harness.main.drain();
    expect(
      harness.servers.filter(({ message }) => message.kind === "event"),
    ).toHaveLength(subscriptions);
    await echoAfterEvents(harness);
    expect(harness.failures).toEqual([]);
  } finally {
    await harness.close();
  }
});
