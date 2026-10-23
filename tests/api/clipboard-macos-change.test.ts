import { expect, test } from "bun:test";
import { ClipboardChanges } from "#plugins/clipboard/src/platforms/changes";
import { MacosClipboard } from "#plugins/clipboard/src/platforms/macos";
import { pollPasteboard } from "#plugins/clipboard/src/platforms/macos-changes";
import type { Pasteboard } from "#plugins/clipboard/src/platforms/macos-pasteboard";

const INTERVAL_MS = 5;
const tick = () => Bun.sleep(INTERVAL_MS * 6);

function counter() {
  let value = 7;
  let failing = false;
  return {
    read: () => {
      if (failing) {
        throw new Error("pasteboard unavailable");
      }
      return value;
    },
    set: (next: number) => {
      value = next;
    },
    fail: (next: boolean) => {
      failing = next;
    },
  };
}

test("the poller reports changes after the counter seen at start and coalesces ticks", async () => {
  const board = counter();
  const seen: number[] = [];
  const driver = pollPasteboard(board.read, INTERVAL_MS);
  driver.listen((sequence) => seen.push(sequence));
  await tick();
  expect(seen).toEqual([]);
  board.set(8);
  board.set(9);
  await tick();
  expect(seen).toEqual([
    9,
  ]);
  await tick();
  expect(seen).toEqual([
    9,
  ]);
  driver.dispose();
  driver.dispose();
  board.set(10);
  await tick();
  expect(seen).toEqual([
    9,
  ]);
});

test("a failing read keeps the last counter and is retried", async () => {
  const board = counter();
  const seen: number[] = [];
  const driver = pollPasteboard(board.read, INTERVAL_MS);
  driver.listen((sequence) => seen.push(sequence));
  board.fail(true);
  board.set(8);
  await tick();
  expect(seen).toEqual([]);
  board.fail(false);
  await tick();
  expect(seen).toEqual([
    8,
  ]);
  driver.dispose();
});

test("the adapter publishes polled changes, serves waiters and stops on dispose", async () => {
  const board = counter();
  const events: unknown[][] = [];
  let released = 0;
  const native = {
    dispose: () => {
      released++;
    },
  } as unknown as Pasteboard;
  const adapter = new MacosClipboard(
    native,
    new ClipboardChanges(pollPasteboard(board.read, INTERVAL_MS), (...event) =>
      events.push(event),
    ),
  );
  const waiting = adapter.waitForChange();
  board.set(8);
  const change = await waiting;
  expect(change.sequence).toBe(8);
  expect(events).toEqual([
    [
      "clipboard.changed",
      change,
    ],
  ]);
  const pending = adapter.waitForChange();
  adapter.dispose();
  adapter.dispose();
  await expect(pending).rejects.toThrow(
    expect.objectContaining({
      code: "CANCELLED",
    }),
  );
  expect(released).toBe(1);
  board.set(9);
  await tick();
  expect(events).toHaveLength(1);
  expect(() => adapter.waitForChange()).toThrow(
    expect.objectContaining({
      code: "CANCELLED",
    }),
  );
});

test("an adapter without an event service fails waits instead of hanging", async () => {
  const adapter = new MacosClipboard({
    dispose() {},
  } as unknown as Pasteboard);
  await expect(adapter.waitForChange()).rejects.toThrow(
    expect.objectContaining({
      code: "INTERNAL",
    }),
  );
  adapter.dispose();
});
