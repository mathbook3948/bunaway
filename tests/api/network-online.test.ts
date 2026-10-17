import { expect, test } from "bun:test";
import network from "@bunaway/plugin-network";
import { NativeRegistry } from "@bunaway/protocol";
import { networkEvents } from "#plugins/network/src/contract";
import { windowsOperations } from "#plugins/network/src/operations";
import {
  hasActiveConnection,
  ONLINE_POLL_INTERVAL_MS,
  watchOnline,
} from "#plugins/network/src/platforms/online-state";

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

test("online means at least one non-loopback interface address", () => {
  expect(hasActiveConnection({})).toBe(false);
  expect(
    hasActiveConnection({
      lo: [
        {
          internal: true,
        },
      ],
    }),
  ).toBe(false);
  expect(
    hasActiveConnection({
      lo: [
        {
          internal: true,
        },
      ],
      Ethernet: undefined,
      "Wi-Fi": [
        {
          internal: true,
        },
        {
          internal: false,
        },
      ],
    }),
  ).toBe(true);
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
