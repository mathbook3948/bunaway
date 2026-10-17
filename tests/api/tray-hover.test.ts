import { expect, test } from "bun:test";
import type { NativeTrayEvent } from "@bunaway/plugin-api/native";
import { trayEventSchema } from "#plugins/tray/src/contract";
import {
  TRAY_LEAVE_POLL_MS,
  TRAY_MOVE_INTERVAL_MS,
  TrayHoverTracker,
} from "#plugins/tray/src/platforms/windows-tray-hover";

type Point = {
  x: number;
  y: number;
};
type Rect = Point & {
  width: number;
  height: number;
};

function harness() {
  let time = 1000;
  let cursor: Point | null = {
    x: 10,
    y: 10,
  };
  let bounds: Rect | null = {
    x: 0,
    y: 0,
    width: 20,
    height: 20,
  };
  let poll: (() => void) | undefined;
  let stopped = 0;
  const events: NativeTrayEvent[] = [];
  const tracker = new TrayHoverTracker({
    now: () => time,
    cursor: () => cursor,
    bounds: () => bounds,
    emit: (event) => events.push(event),
    startPolling: (callback, intervalMs) => {
      expect(intervalMs).toBe(TRAY_LEAVE_POLL_MS);
      poll = callback;
      return () => {
        stopped++;
        poll = undefined;
      };
    },
  });
  return {
    tracker,
    events,
    states: () => events.map((event) => event.state),
    advance: (ms: number) => {
      time += ms;
    },
    setCursor: (value: Point | null) => {
      cursor = value;
    },
    setBounds: (value: Rect | null) => {
      bounds = value;
    },
    tick: () => poll?.(),
    polling: () => poll !== undefined,
    stopped: () => stopped,
  };
}

test("hover enters once, throttles moves and leaves when the pointer exits the icon", () => {
  const h = harness();
  h.tracker.mouseMoved();
  h.tracker.mouseMoved();
  expect(h.states()).toEqual([
    "enter",
  ]);
  h.advance(TRAY_MOVE_INTERVAL_MS - 1);
  h.tracker.mouseMoved();
  expect(h.states()).toEqual([
    "enter",
  ]);
  h.advance(1);
  h.tracker.mouseMoved();
  expect(h.states()).toEqual([
    "enter",
    "move",
  ]);
  h.tick();
  expect(h.states()).toEqual([
    "enter",
    "move",
  ]);
  h.setCursor({
    x: 20,
    y: 10,
  });
  h.tick();
  expect(h.states()).toEqual([
    "enter",
    "move",
    "leave",
  ]);
  expect(h.events.at(-1)).toMatchObject({
    button: "none",
    position: {
      x: 20,
      y: 10,
    },
  });
  expect(h.polling()).toBe(false);
  for (const event of h.events) {
    expect(trayEventSchema.safeParse(event).success).toBe(true);
  }
  h.advance(1);
  h.tracker.mouseMoved();
  expect(h.states().at(-1)).toBe("enter");
});

test("unreadable bounds or cursor end hover, and dispose stops without leave", () => {
  const unknownBounds = harness();
  unknownBounds.tracker.mouseMoved();
  unknownBounds.setBounds(null);
  unknownBounds.tick();
  expect(unknownBounds.states()).toEqual([
    "enter",
    "leave",
  ]);

  const unknownCursor = harness();
  unknownCursor.tracker.mouseMoved();
  unknownCursor.setCursor(null);
  unknownCursor.tick();
  expect(unknownCursor.states()).toEqual([
    "enter",
    "leave",
  ]);
  expect(unknownCursor.events.at(-1)?.position).toBeNull();

  const disposed = harness();
  disposed.tracker.mouseMoved();
  disposed.tracker.dispose();
  disposed.tracker.dispose();
  expect(disposed.stopped()).toBe(1);
  expect(disposed.states()).toEqual([
    "enter",
  ]);
});
