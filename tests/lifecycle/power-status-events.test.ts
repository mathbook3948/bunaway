import { expect, test } from "bun:test";
import type { NativeSystemSignal } from "@bunaway/plugin-api/native";
import type { PowerStatus } from "#plugins/power/src/contract";
import { watchPowerStatus } from "#plugins/power/src/platforms/windows-status-events";

const ON_AC: PowerStatus = {
  source: "ac",
  batteryPresent: true,
  charging: true,
  batteryPercent: 80,
  batterySaver: false,
  remainingSeconds: null,
  fullLifeSeconds: null,
};
const ON_BATTERY: PowerStatus = {
  source: "battery",
  batteryPresent: true,
  charging: false,
  batteryPercent: 79,
  batterySaver: false,
  remainingSeconds: 7200,
  fullLifeSeconds: 10800,
};

function fixture() {
  let status = ON_AC;
  let reads = 0;
  let subscriptions = 0;
  let unsubscribes = 0;
  let failRead = false;
  let receive: ((signal: NativeSystemSignal) => void) | undefined;
  const published: unknown[][] = [];
  const release = watchPowerStatus(
    () => {
      reads++;
      if (failRead) {
        throw new Error("Read failed");
      }
      return structuredClone(status);
    },
    {
      subscribe(callback) {
        subscriptions++;
        receive = callback;
        return () => {
          unsubscribes++;
        };
      },
      publish(...args) {
        published.push(args);
      },
    },
  );
  return {
    release,
    published,
    get reads() {
      return reads;
    },
    get subscriptions() {
      return subscriptions;
    },
    get unsubscribes() {
      return unsubscribes;
    },
    set(value: PowerStatus) {
      status = value;
    },
    failRead(value: boolean) {
      failRead = value;
    },
    signal(value: NativeSystemSignal) {
      receive?.(value);
    },
  };
}

test("subscribes once with a single baseline read", () => {
  const f = fixture();
  expect(f.subscriptions).toBe(1);
  expect(f.reads).toBe(1);
  expect(f.published).toEqual([]);
});

test("without system events nothing is read or subscribed", () => {
  let reads = 0;
  const release = watchPowerStatus(() => {
    reads++;
    return ON_AC;
  });
  expect(release).toBeUndefined();
  expect(reads).toBe(0);
});

test("status broadcasts and resume re-read, but equal values are not published", () => {
  const f = fixture();
  f.signal("powerStatusChanged");
  f.signal("resume");
  expect(f.reads).toBe(3);
  expect(f.published).toEqual([]);
});

test("a changed status is published once with the read grant and then deduplicated", () => {
  const f = fixture();
  f.set(ON_BATTERY);
  f.signal("powerStatusChanged");
  expect(f.published).toEqual([
    [
      "power.statusChanged",
      ON_BATTERY,
      "power.getStatus",
    ],
  ]);
  f.signal("resume");
  expect(f.published).toHaveLength(1);
  // Returning to the baseline differs from the last published value and is reported.
  f.set(ON_AC);
  f.signal("resume");
  expect(f.published.map(([, payload]) => payload)).toEqual([
    ON_BATTERY,
    ON_AC,
  ]);
});

test("unrelated signals do not read", () => {
  const f = fixture();
  f.set(ON_BATTERY);
  for (const signal of [
    "themeChanged",
    "settingChanged",
    "suspend",
    "sessionLocked",
  ] as const) {
    f.signal(signal);
  }
  expect(f.reads).toBe(1);
  expect(f.published).toEqual([]);
});

test("a failed re-read propagates and keeps the baseline for the next signal", () => {
  const f = fixture();
  f.set(ON_BATTERY);
  f.failRead(true);
  expect(() => f.signal("powerStatusChanged")).toThrow("Read failed");
  expect(f.published).toEqual([]);
  f.failRead(false);
  f.signal("powerStatusChanged");
  expect(f.published).toHaveLength(1);
});

test("release is repeatable and stops later reads and publications", () => {
  const f = fixture();
  f.release?.();
  f.release?.();
  expect(f.unsubscribes).toBe(1);
  f.set(ON_BATTERY);
  f.signal("powerStatusChanged");
  expect(f.reads).toBe(1);
  expect(f.published).toEqual([]);
});
