import { expect, setDefaultTimeout, test } from "bun:test";
import { ClipboardChanges } from "#plugins/clipboard/src/platforms/changes";
import { MacosClipboard } from "#plugins/clipboard/src/platforms/macos";
import { pollPasteboard } from "#plugins/clipboard/src/platforms/macos-changes";
import type { Pasteboard } from "#plugins/clipboard/src/platforms/macos-pasteboard";
import { deadline, waitFor } from "../fixtures/deadlines.ts";

setDefaultTimeout(deadline("inProcess"));

/** An interval that never fires inside a test, so `flush` is the only comparison. */
const MANUAL_MS = 3_600_000;

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

function adapter(board: ReturnType<typeof counter>, intervalMs = MANUAL_MS) {
  const events: unknown[][] = [];
  const released = {
    count: 0,
  };
  const driver = pollPasteboard(board.read, intervalMs);
  const clipboard = new MacosClipboard(
    {
      dispose: () => {
        released.count++;
      },
    } as unknown as Pasteboard,
    new ClipboardChanges(driver, (...event) => events.push(event)),
  );
  return {
    clipboard,
    driver,
    events,
    released,
  };
}

test("the poller reports changes after the counter seen at start and coalesces them", () => {
  const board = counter();
  const seen: number[] = [];
  const driver = pollPasteboard(board.read, MANUAL_MS);
  driver.listen((sequence) => seen.push(sequence));
  driver.flush?.();
  expect(seen).toEqual([]);
  board.set(8);
  board.set(9);
  driver.flush?.();
  driver.flush?.();
  expect(seen).toEqual([
    9,
  ]);
  driver.dispose();
  driver.dispose();
  board.set(10);
  driver.flush?.();
  expect(seen).toEqual([
    9,
  ]);
});

test("a failing baseline read fails listening and a later failing read is retried", () => {
  const board = counter();
  const driver = pollPasteboard(board.read, MANUAL_MS);
  board.fail(true);
  expect(() => driver.listen(() => {})).toThrow("pasteboard unavailable");
  board.fail(false);
  const seen: number[] = [];
  driver.listen((sequence) => seen.push(sequence));
  board.fail(true);
  board.set(8);
  driver.flush?.();
  expect(seen).toEqual([]);
  board.fail(false);
  driver.flush?.();
  expect(seen).toEqual([
    8,
  ]);
  driver.dispose();
});

test("the timer compares on its own without being flushed", async () => {
  const board = counter();
  const seen: number[] = [];
  const driver = pollPasteboard(board.read, 5);
  driver.listen((sequence) => seen.push(sequence));
  board.set(8);
  await waitFor(() => seen.length > 0 || undefined, {
    deadline: "inProcess",
    what: "the polled change",
  });
  expect(seen).toEqual([
    8,
  ]);
  driver.dispose();
});

test("a wait does not resolve with a change made before it started", async () => {
  const board = counter();
  const { clipboard, driver, events } = adapter(board);
  board.set(8);
  const waiting = clipboard.waitForChange();
  let settled = false;
  void waiting.then(() => {
    settled = true;
  });
  await Bun.sleep(0);
  expect(settled).toBe(false);
  // The earlier change is still published as an event.
  expect(events.map(([event]) => event)).toEqual([
    "clipboard.changed",
  ]);
  board.set(9);
  driver.flush?.();
  expect((await waiting).sequence).toBe(9);
  clipboard.dispose();
});

test("the adapter publishes changes, serves waiters and stops on dispose", async () => {
  const board = counter();
  const { clipboard, driver, events, released } = adapter(board);
  const waiting = clipboard.waitForChange();
  board.set(8);
  driver.flush?.();
  const change = await waiting;
  expect(change.sequence).toBe(8);
  expect(events).toEqual([
    [
      "clipboard.changed",
      change,
    ],
  ]);
  const pending = clipboard.waitForChange();
  clipboard.dispose();
  clipboard.dispose();
  await expect(pending).rejects.toThrow(
    expect.objectContaining({
      code: "CANCELLED",
    }),
  );
  expect(released.count).toBe(1);
  board.set(9);
  driver.flush?.();
  expect(events).toHaveLength(1);
  expect(() => clipboard.waitForChange()).toThrow(
    expect.objectContaining({
      code: "CANCELLED",
    }),
  );
});

test("an adapter without an event service fails waits instead of hanging", async () => {
  const clipboard = new MacosClipboard({
    dispose() {},
  } as unknown as Pasteboard);
  await expect(clipboard.waitForChange()).rejects.toThrow(
    expect.objectContaining({
      code: "INTERNAL",
    }),
  );
  clipboard.dispose();
});
