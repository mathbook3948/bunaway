import { expect, test } from "bun:test";
import type { NativeEnvironment } from "@bunaway/plugin";
import network from "@bunaway/plugin-network";
import { NativeRegistry } from "@bunaway/protocol";
import { networkEvents } from "#plugins/network/src/contract";
import { windowsOperations } from "#plugins/network/src/operations";
import {
  hasActiveConnection,
  ONLINE_POLL_INTERVAL_MS,
  watchOnline,
} from "#plugins/network/src/platforms/online-state";
import { dispose, initialize } from "#plugins/network/src/platforms/shared";

test("network.isOnline needs its own grant and takes no input", () => {
  const registry = new NativeRegistry([
    network._definition,
  ]);
  const call = {
    operation: "network.isOnline",
    payload: null,
  };
  expect(
    registry.allowed(
      {
        permissions: [
          "network.isOnline",
        ],
      },
      call,
    ),
  ).toBe(true);
  for (const permissions of [
    [],
    [
      "network.request",
      "network.exchange",
    ],
  ]) {
    expect(
      registry.allowed(
        {
          permissions,
        },
        call,
      ),
    ).toBe(false);
  }
  expect(windowsOperations.isOnline.input.safeParse(null).success).toBe(true);
  expect(windowsOperations.isOnline.input.safeParse({}).success).toBe(false);
  expect(windowsOperations.isOnline.output.safeParse(true).success).toBe(true);
  expect(windowsOperations.isOnline.output.safeParse("yes").success).toBe(
    false,
  );
});

test("network.onlineChanged declares one strict boolean payload", () => {
  expect(Object.keys(networkEvents)).toEqual([
    "network.onlineChanged",
  ]);
  expect(networkEvents["network.onlineChanged"]).toMatchObject({
    properties: {
      online: {
        type: "boolean",
      },
    },
    required: [
      "online",
    ],
    additionalProperties: false,
  });
});

const loopback = {
  address: "127.0.0.1",
  internal: true,
};
const lan = {
  address: "192.168.0.10",
  internal: false,
};

test("online means at least one non-loopback, non-link-local address", () => {
  expect(hasActiveConnection({})).toBe(false);
  expect(
    hasActiveConnection({
      lo: [
        loopback,
      ],
    }),
  ).toBe(false);
  expect(
    hasActiveConnection({
      lo: [
        loopback,
      ],
      Ethernet: undefined,
      "Wi-Fi": [
        loopback,
        lan,
      ],
    }),
  ).toBe(true);
  expect(
    hasActiveConnection({
      Ethernet: [
        {
          address: "2001:db8::1",
          internal: false,
        },
      ],
    }),
  ).toBe(true);
});

test("link-local addresses alone do not count as a connection", () => {
  for (const address of [
    "169.254.10.20",
    "fe80::1",
    "fe80::1ff:fe23:4567:890a",
    "febf::1",
  ]) {
    expect(
      hasActiveConnection({
        awdl0: [
          {
            address,
            internal: false,
          },
        ],
      }),
    ).toBe(false);
  }
  // Addresses next to the link-local ranges are ordinary.
  for (const address of [
    "169.253.1.1",
    "169.255.1.1",
    "fec0::1",
    "fe7f::1",
  ]) {
    expect(
      hasActiveConnection({
        eth0: [
          {
            address,
            internal: false,
          },
        ],
      }),
    ).toBe(true);
  }
});

function fakeWatchHost(initial: boolean) {
  let online = initial;
  let tick: (() => void) | undefined;
  let stops = 0;
  const published: boolean[] = [];
  const failures: unknown[] = [];
  const host = {
    read: () => online,
    publish: (value: boolean) => {
      published.push(value);
    },
    startPolling: (poll: () => void, intervalMs: number) => {
      expect(intervalMs).toBe(ONLINE_POLL_INTERVAL_MS);
      tick = poll;
      return () => {
        stops++;
      };
    },
    fail: (error: unknown) => {
      failures.push(error);
    },
  };
  return {
    host,
    published,
    failures,
    set: (value: boolean) => {
      online = value;
    },
    tick: () => tick?.(),
    stops: () => stops,
  };
}

test("online watcher publishes only real changes and never the baseline", () => {
  const fake = fakeWatchHost(true);
  const stop = watchOnline(fake.host);
  fake.tick();
  expect(fake.published).toEqual([]);
  fake.set(false);
  fake.tick();
  fake.tick();
  fake.set(true);
  fake.tick();
  expect(fake.published).toEqual([
    false,
    true,
  ]);
  stop();
  stop();
  fake.set(false);
  fake.tick();
  expect(fake.published).toEqual([
    false,
    true,
  ]);
  expect(fake.stops()).toBe(2);
});

test("online watcher keeps its baseline when publishing fails and retries next tick", () => {
  const fake = fakeWatchHost(true);
  let failPublish = true;
  const published: boolean[] = [];
  watchOnline({
    ...fake.host,
    publish: (value) => {
      if (failPublish) {
        throw new Error("boom");
      }
      published.push(value);
    },
  });
  fake.set(false);
  fake.tick();
  expect(fake.failures).toHaveLength(1);
  failPublish = false;
  fake.tick();
  expect(published).toEqual([
    false,
  ]);
});

test("online watcher survives a failing baseline read and takes the baseline later without publishing", () => {
  const fake = fakeWatchHost(true);
  let failRead = true;
  const published: boolean[] = [];
  watchOnline({
    ...fake.host,
    read: () => {
      if (failRead) {
        throw new Error("boom");
      }
      return fake.host.read();
    },
    publish: (value) => {
      published.push(value);
    },
  });
  expect(fake.failures).toHaveLength(1);
  fake.tick();
  expect(fake.failures).toHaveLength(2);
  failRead = false;
  fake.tick();
  expect(published).toEqual([]);
  fake.set(false);
  fake.tick();
  expect(published).toEqual([
    false,
  ]);
});

test("initialize watches only with system events, publishes the event with its read grant and stops on dispose", async () => {
  const fake = fakeWatchHost(true);
  const seams = {
    read: fake.host.read,
    startPolling: fake.host.startPolling,
  };
  const withoutEvents = initialize(undefined, seams);
  expect(withoutEvents.stopOnlineWatch).toBeUndefined();
  expect(fake.stops()).toBe(0);

  const calls: unknown[][] = [];
  const environment = {
    dataRoot: ".",
    capabilities: [],
    windows: {
      specs: [],
      systemEvents: {
        subscribe: () => () => {},
        publish: (...args: unknown[]) => {
          calls.push(args);
        },
      },
    },
  } as unknown as NativeEnvironment;
  const state = initialize(environment, seams);
  fake.tick();
  expect(calls).toEqual([]);
  fake.set(false);
  fake.tick();
  expect(calls).toEqual([
    [
      "network.onlineChanged",
      {
        online: false,
      },
      "network.isOnline",
    ],
  ]);
  await dispose(state);
  await dispose(state);
  expect(fake.stops()).toBe(1);
  fake.set(true);
  fake.tick();
  expect(calls).toHaveLength(1);
});
