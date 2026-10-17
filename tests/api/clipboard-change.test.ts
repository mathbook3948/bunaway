import { expect, test } from "bun:test";
import clipboard from "@bunaway/plugin-clipboard";
import { type JsonValue, NativeRegistry } from "@bunaway/protocol";
import {
  changeSchema,
  clipboardEvents,
  MAX_CHANGE_WAITERS,
  validateClipboardInput,
} from "#plugins/clipboard/src/contract";
import {
  macosOperations,
  windowsOperations,
} from "#plugins/clipboard/src/operations";
import {
  type ChangeDriver,
  ClipboardChanges,
} from "#plugins/clipboard/src/platforms/windows-changes";
import { pluginParsers } from "../fixtures/plugin-parsers.ts";

function fixture(attached = true) {
  const events: [
    string,
    JsonValue,
  ][] = [];
  let receive: (sequence: number) => void = () => {};
  let disposed = 0;
  const driver: ChangeDriver = {
    listen(listener) {
      receive = listener;
    },
    dispose() {
      disposed++;
    },
  };
  let clock = 1000;
  const changes = new ClipboardChanges(
    attached ? driver : undefined,
    (event, payload) =>
      events.push([
        event,
        payload,
      ]),
    () => clock++,
  );
  return {
    changes,
    events,
    notify: (sequence: number) => receive(sequence),
    disposed: () => disposed,
  };
}

test("change contract has its own permission, a content-free payload and no macOS operation", async () => {
  expect(
    new NativeRegistry([
      clipboard._definition,
    ]).operations.has("clipboard.waitForChange"),
  ).toBe(true);
  expect("waitForChange" in windowsOperations).toBe(true);
  expect("waitForChange" in macosOperations).toBe(false);
  expect(Object.keys(clipboardEvents)).toEqual([
    "clipboard.changed",
  ]);
  expect(
    Object.keys(clipboardEvents["clipboard.changed"].payload.properties),
  ).toEqual([
    "sequence",
    "changedAt",
  ]);
  const parsers = pluginParsers("clipboard", windowsOperations);
  expect(
    (
      await parsers.validateCall({
        operation: "clipboard.waitForChange",
        payload: null,
      })
    ).payload,
  ).toBeNull();
  await expect(
    parsers.validateCall({
      operation: "clipboard.waitForChange",
      payload: {},
    }),
  ).rejects.toBeDefined();
  expect(validateClipboardInput("clipboard.waitForChange", null)).toBeNull();
  expect(() => validateClipboardInput("clipboard.waitForChange", {})).toThrow();
  expect(
    changeSchema.safeParse({
      sequence: 0xffff_ffff,
      changedAt: 1,
    }).success,
  ).toBe(true);
  for (const invalid of [
    {
      sequence: -1,
      changedAt: 1,
    },
    {
      sequence: 1.5,
      changedAt: 1,
    },
    {
      sequence: 0x1_0000_0000,
      changedAt: 1,
    },
    {
      sequence: 1,
      changedAt: 1,
      text: "secret",
    },
  ]) {
    expect(changeSchema.safeParse(invalid).success).toBe(false);
  }
});

test("a change is emitted once per sequence number and delivered to current waiters only", async () => {
  const f = fixture();
  f.notify(1);
  const first = f.changes.wait();
  const second = f.changes.wait();
  f.notify(2);
  // Queued updates that resolve to the same sequence number merge into one notification.
  f.notify(2);
  const expected = {
    sequence: 2,
    changedAt: 1001,
  };
  expect(await first).toEqual(expected);
  expect(await second).toEqual(expected);
  expect(f.events).toEqual([
    [
      "clipboard.changed",
      {
        sequence: 1,
        changedAt: 1000,
      },
    ],
    [
      "clipboard.changed",
      expected,
    ],
  ]);
  expect(changeSchema.parse(f.events[1]?.[1])).toEqual(expected);
  f.notify(3);
  expect(f.events).toHaveLength(3);
});

test("waits are bounded, cancellable and rejected on disposal; disposal is repeatable", async () => {
  const f = fixture();
  const controller = new AbortController();
  const cancelled = f.changes.wait(controller.signal);
  controller.abort();
  await expect(cancelled).rejects.toMatchObject({
    code: "CANCELLED",
  });
  const waiting = Array.from(
    {
      length: MAX_CHANGE_WAITERS,
    },
    () => f.changes.wait(),
  );
  await expect(f.changes.wait()).rejects.toMatchObject({
    code: "BUSY",
  });
  f.changes.dispose();
  f.changes.dispose();
  expect(f.disposed()).toBe(1);
  for (const wait of waiting) {
    await expect(wait).rejects.toMatchObject({
      code: "CANCELLED",
    });
  }
  f.notify(9);
  expect(f.events).toHaveLength(0);
  await expect(f.changes.wait()).rejects.toMatchObject({
    code: "CANCELLED",
  });
});

test("without a native listener waits fail instead of hanging", async () => {
  const f = fixture(false);
  await expect(f.changes.wait()).rejects.toMatchObject({
    code: "INTERNAL",
  });
  f.changes.dispose();
  expect(f.disposed()).toBe(0);
});
