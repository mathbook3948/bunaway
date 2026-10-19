import { expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import {
  isAppRelaunchAck,
  readAppRelaunchRequest,
} from "@bunaway/runtime-bun/development";
import {
  MAX_LAUNCH_ARGUMENT_BYTES,
  MAX_LAUNCH_ARGUMENTS,
} from "@bunaway/runtime-bun/worker-channel";
import { requestCliRelaunch } from "#native/windows/bun/boot";

/** A stand-in for the IPC channel to the development CLI. */
function fakeIpc(onSend: (message: unknown, channel: EventEmitter) => void) {
  const channel = new EventEmitter();
  const sent: unknown[] = [];
  return {
    channel,
    sent,
    ipc: {
      send(message: unknown) {
        sent.push(message);
        onSend(message, channel);
      },
      on: channel.on.bind(channel),
      off: channel.off.bind(channel),
    },
  };
}

test("readAppRelaunchRequest accepts the limits and rejects anything beyond", () => {
  const request = (argv: unknown, extra: object = {}) => ({
    kind: "bunaway:relaunch-app",
    argv,
    ...extra,
  });
  expect(readAppRelaunchRequest(request([])).argv).toEqual([]);
  expect(
    readAppRelaunchRequest(request(Array(MAX_LAUNCH_ARGUMENTS).fill("x"))).argv,
  ).toHaveLength(MAX_LAUNCH_ARGUMENTS);
  const nearLimit = "y".repeat(MAX_LAUNCH_ARGUMENT_BYTES - 4);
  expect(
    readAppRelaunchRequest(
      request([
        nearLimit,
      ]),
    ).argv,
  ).toEqual([
    nearLimit,
  ]);
  for (const invalid of [
    request(Array(MAX_LAUNCH_ARGUMENTS + 1).fill("x")),
    request([
      "y".repeat(MAX_LAUNCH_ARGUMENT_BYTES),
    ]),
    request([
      "a\0b",
    ]),
    request([
      1,
    ]),
    request("x"),
    request([], {
      extra: 1,
    }),
    {
      kind: "bunaway:relaunch-app",
    },
    {
      kind: "other",
      argv: [],
    },
    null,
  ]) {
    expect(() => readAppRelaunchRequest(invalid)).toThrow(
      "Invalid app relaunch request.",
    );
  }
  expect(
    isAppRelaunchAck({
      kind: "bunaway:relaunch-ack",
    }),
  ).toBe(true);
  expect(
    isAppRelaunchAck({
      kind: "bunaway:relaunch-ack",
      x: 1,
    }),
  ).toBe(false);
  expect(isAppRelaunchAck(null)).toBe(false);
});

test("the development host sends its relaunch request and waits for the CLI acknowledgement", async () => {
  const { ipc, sent, channel } = fakeIpc((_message, channel) => {
    queueMicrotask(() =>
      channel.emit("message", {
        kind: "bunaway:relaunch-ack",
      }),
    );
  });
  await requestCliRelaunch(
    ipc,
    [
      "--again",
    ],
    5000,
  );
  expect(sent).toEqual([
    {
      kind: "bunaway:relaunch-app",
      argv: [
        "--again",
      ],
    },
  ]);
  // The listeners are gone once the acknowledgement arrived.
  expect(channel.listenerCount("message")).toBe(0);
  expect(channel.listenerCount("disconnect")).toBe(0);
});

test("the development host never waits longer than its deadline for an acknowledgement", async () => {
  const silent = fakeIpc(() => {});
  const started = Date.now();
  await requestCliRelaunch(silent.ipc, [], 50);
  expect(Date.now() - started).toBeLessThan(2000);
  expect(silent.channel.listenerCount("message")).toBe(0);

  // A channel that closes ends the wait at once.
  const closing = fakeIpc((_message, channel) => {
    queueMicrotask(() => channel.emit("disconnect"));
  });
  await requestCliRelaunch(closing.ipc, [], 5000);

  // A send that throws, or a missing channel, never leaves the wait pending.
  const broken = fakeIpc(() => {
    throw new Error("channel closed");
  });
  // The host logs the failure; capture it so the expected error does not appear in CI output.
  const logged = spyOn(console, "error").mockImplementation(() => {});
  try {
    await requestCliRelaunch(broken.ipc, [], 5000);
    expect(logged).toHaveBeenCalledTimes(1);
    expect(logged.mock.calls[0]?.[0]).toBe("Relaunch request failed:");
  } finally {
    logged.mockRestore();
  }
  expect(broken.channel.listenerCount("message")).toBe(0);
  await expect(
    requestCliRelaunch(
      {
        on: () => {},
        off: () => {},
      },
      [],
      50,
    ),
  ).rejects.toThrow("No channel");
});
