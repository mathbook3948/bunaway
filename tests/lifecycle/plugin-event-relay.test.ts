import { expect, test } from "bun:test";
import { BunawayError } from "@bunaway/protocol";
import type { Packet } from "@bunaway/runtime-bun/worker-channel";
import { relayPluginEvent } from "#native/windows/bun/plugin-event-relay";

const packet: Extract<
  Packet,
  {
    kind: "plugin-event";
  }
> = {
  kind: "plugin-event",
  event: "probe.changed",
  payload: 1,
  requiredOperation: null,
  dropped: 0,
};

/** Runs the relay against recording hooks and reports what it sent and logged. */
async function relay(
  options: {
    stopping?: () => boolean;
    send?: () => Promise<void>;
    dropped?: number;
  } = {},
) {
  const sent: unknown[] = [];
  const recorded: number[] = [];
  const outcome = await relayPluginEvent(
    {
      ...packet,
      dropped: options.dropped ?? 0,
    },
    options.stopping ?? (() => false),
    async (event) => {
      sent.push(event);
      await options.send?.();
    },
    async (dropped) => {
      recorded.push(dropped);
    },
  ).then(
    () => "relayed",
    (error: unknown) => error,
  );
  return {
    outcome,
    sent,
    recorded,
  };
}

test("a plugin event is forwarded unchanged and a drop count is recorded once before it", async () => {
  const plain = await relay();
  expect(plain.outcome).toBe("relayed");
  expect(plain.sent).toEqual([
    packet,
  ]);
  expect(plain.recorded).toEqual([]);
  const counted = await relay({
    dropped: 4,
  });
  expect(counted.recorded).toEqual([
    4,
  ]);
  expect(counted.sent).toHaveLength(1);
});

test("a full UI lane or a stopping host drops the event without failing the Workers", async () => {
  const busy = await relay({
    send: () =>
      Promise.reject(
        new BunawayError({
          code: "BUSY",
          message: "Native event queue full.",
        }),
      ),
  });
  expect(busy.outcome).toBe("relayed");
  // A closing channel during shutdown is not a failure either.
  let stopping = false;
  const closing = await relay({
    stopping: () => stopping,
    send() {
      stopping = true;
      return Promise.reject(new Error("Worker channel closed"));
    },
  });
  expect(closing.outcome).toBe("relayed");
  const late = await relay({
    stopping: () => true,
  });
  expect(late.outcome).toBe("relayed");
  expect(late.sent).toEqual([]);
});

test("a broken UI channel while running is a host failure", async () => {
  const failure = new Error("Worker channel closed");
  const broken = await relay({
    send: () => Promise.reject(failure),
  });
  expect(broken.outcome).toBe(failure);
});
