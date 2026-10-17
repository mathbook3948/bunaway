import { expect, test } from "bun:test";
import type {
  NativeSystemEvents,
  NativeSystemSignal,
} from "@bunaway/plugin-api/native";
import { powerEvents } from "#plugins/power/src/contract";
import { watchPowerLifecycle } from "#plugins/power/src/platforms/windows-lifecycle-events";
import { watchPowerStatus } from "#plugins/power/src/platforms/windows-status-events";

/** Fake system event service that records subscription options and published events. */
function fakeSystemEvents() {
  let receive: ((signal: NativeSystemSignal) => void) | undefined;
  const published: unknown[][] = [];
  const options: unknown[] = [];
  let unsubscribed = 0;
  const systemEvents: Pick<NativeSystemEvents, "subscribe" | "publish"> = {
    subscribe(callback, subscribeOptions) {
      receive = callback;
      options.push(subscribeOptions);
      return () => {
        unsubscribed++;
      };
    },
    publish: (...args) => {
      published.push(args);
    },
  };
  return {
    systemEvents,
    published,
    options,
    emit: (signal: NativeSystemSignal) => receive?.(signal),
    unsubscribed: () => unsubscribed,
  };
}

test("lifecycle signals map to empty power events under the status read grant", () => {
  const fake = fakeSystemEvents();
  watchPowerLifecycle(fake.systemEvents);
  for (const signal of [
    "suspend",
    "resume",
    "sessionLocked",
    "sessionUnlocked",
  ] as const) {
    fake.emit(signal);
  }
  expect(fake.published).toEqual(
    [
      "power.suspended",
      "power.resumed",
      "power.sessionLocked",
      "power.sessionUnlocked",
    ].map((event) => [
      event,
      {},
      "power.getStatus",
    ]),
  );
  for (const [event] of fake.published) {
    expect(Object.keys(powerEvents)).toContain(event as string);
  }
  expect(fake.options).toEqual([
    {
      sessionNotifications: true,
    },
  ]);
});

test("other signals are ignored and release stops publishing and is repeatable", () => {
  const fake = fakeSystemEvents();
  const release = watchPowerLifecycle(fake.systemEvents);
  for (const signal of [
    "settingChanged",
    "themeChanged",
    "colorsChanged",
    "accentChanged",
    "powerStatusChanged",
  ] as const) {
    fake.emit(signal);
  }
  expect(fake.published).toEqual([]);
  release?.();
  release?.();
  fake.emit("suspend");
  fake.emit("sessionLocked");
  expect(fake.published).toEqual([]);
  expect(fake.unsubscribed()).toBe(1);
});

test("a resume publishes power.resumed before a changed power.statusChanged in subscription order", () => {
  const callbacks: ((signal: NativeSystemSignal) => void)[] = [];
  const published: string[] = [];
  const systemEvents: Pick<NativeSystemEvents, "subscribe" | "publish"> = {
    subscribe(callback) {
      callbacks.push(callback);
      return () => {};
    },
    publish: (event) => {
      published.push(event);
    },
  };
  let percent = 100;
  const status = () =>
    ({
      source: "battery",
      batteryPresent: true,
      charging: false,
      batteryPercent: percent,
      batterySaver: false,
      remainingSeconds: null,
      fullLifeSeconds: null,
    }) as const;
  // Same order as the WindowsPower constructor.
  watchPowerLifecycle(systemEvents);
  watchPowerStatus(status, systemEvents);
  percent = 90;
  for (const callback of callbacks) {
    callback("resume");
  }
  expect(published).toEqual([
    "power.resumed",
    "power.statusChanged",
  ]);
});

test("lifecycle events are declared with empty strict payloads and no service yields no release", () => {
  for (const name of [
    "power.suspended",
    "power.resumed",
    "power.sessionLocked",
    "power.sessionUnlocked",
  ] as const) {
    expect(powerEvents[name]).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
  }
  expect(watchPowerLifecycle(undefined)).toBeUndefined();
});
