import { expect, test } from "bun:test";
import type {
  NativeSystemEvents,
  NativeSystemSignal,
} from "@bunaway/plugin-api/native";
import { powerEvents } from "#plugins/power/src/contract";
import {
  type LifecycleTimers,
  watchPowerLifecycle,
} from "#plugins/power/src/platforms/windows-lifecycle-events";
import { watchPowerStatus } from "#plugins/power/src/platforms/windows-status-events";

/** Fake system event service that records subscription options and published events. */
function fakeSystemEvents() {
  const receivers: ((signal: NativeSystemSignal) => void)[] = [];
  let failSessions = false;
  const published: unknown[][] = [];
  const options: unknown[] = [];
  let unsubscribed = 0;
  const systemEvents: Pick<NativeSystemEvents, "subscribe" | "publish"> = {
    subscribe(callback, subscribeOptions) {
      if (failSessions && subscribeOptions?.sessionNotifications) {
        throw new Error("RPC_S_INVALID_BINDING");
      }
      receivers.push(callback);
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
    emit: (signal: NativeSystemSignal) => {
      for (const receive of receivers) {
        receive(signal);
      }
    },
    setSessionFailing: (failing: boolean) => {
      failSessions = failing;
    },
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
  // Only the lock subscription opts in to session notifications.
  expect(fake.options).toEqual([
    undefined,
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
  expect(fake.unsubscribed()).toBe(2);
});

/** Manual timers: tests fire pending callbacks explicitly. */
function fakeTimers() {
  const pending = new Map<number, () => void>();
  let next = 0;
  const timers: LifecycleTimers = {
    setTimeout: (callback) => {
      pending.set(++next, callback);
      return next;
    },
    clearTimeout: (handle) => {
      pending.delete(handle as number);
    },
  };
  return {
    timers,
    pending: () => pending.size,
    /** Fire every currently pending timer once. */
    fire: () => {
      for (const [handle, callback] of [
        ...pending,
      ]) {
        pending.delete(handle);
        callback();
      }
    },
  };
}

/** Capture console.error calls made while `run` executes. */
function captureErrors<T>(run: () => T): {
  result: T;
  logged: unknown[][];
} {
  const logged: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args);
  };
  try {
    return {
      result: run(),
      logged,
    };
  } finally {
    console.error = original;
  }
}

test("a failing session registration keeps suspend and resume events and logs the failure", () => {
  const fake = fakeSystemEvents();
  const clock = fakeTimers();
  fake.setSessionFailing(true);
  const { result: release, logged } = captureErrors(() =>
    watchPowerLifecycle(fake.systemEvents, clock.timers),
  );
  expect(logged).toHaveLength(1);
  for (const signal of [
    "suspend",
    "sessionLocked",
    "resume",
  ] as const) {
    fake.emit(signal);
  }
  expect(fake.published.map(([event]) => event)).toEqual([
    "power.suspended",
    "power.resumed",
  ]);
  release?.();
  expect(fake.unsubscribed()).toBe(1);
  expect(clock.pending()).toBe(0);
});

test("a failed session registration is retried until it succeeds and then stops", () => {
  const fake = fakeSystemEvents();
  const clock = fakeTimers();
  fake.setSessionFailing(true);
  const { result: release } = captureErrors(() =>
    watchPowerLifecycle(fake.systemEvents, clock.timers),
  );
  captureErrors(() => clock.fire());
  expect(clock.pending()).toBe(1);
  fake.emit("sessionLocked");
  expect(fake.published).toEqual([]);
  fake.setSessionFailing(false);
  clock.fire();
  expect(clock.pending()).toBe(0);
  fake.emit("sessionLocked");
  fake.emit("sessionUnlocked");
  expect(fake.published.map(([event]) => event)).toEqual([
    "power.sessionLocked",
    "power.sessionUnlocked",
  ]);
  release?.();
  expect(fake.unsubscribed()).toBe(2);
});

test("session registration retries stop after the bounded window with a second diagnostic", () => {
  const fake = fakeSystemEvents();
  const clock = fakeTimers();
  fake.setSessionFailing(true);
  const { logged } = captureErrors(() => {
    watchPowerLifecycle(fake.systemEvents, clock.timers);
    let rounds = 0;
    while (clock.pending() > 0) {
      clock.fire();
      rounds++;
    }
    // 120 s window at 5 s intervals.
    expect(rounds).toBe(24);
  });
  expect(logged).toHaveLength(2);
});

test("release cancels a pending session retry", () => {
  const fake = fakeSystemEvents();
  const clock = fakeTimers();
  fake.setSessionFailing(true);
  const { result: release } = captureErrors(() =>
    watchPowerLifecycle(fake.systemEvents, clock.timers),
  );
  expect(clock.pending()).toBe(1);
  release?.();
  expect(clock.pending()).toBe(0);
  fake.setSessionFailing(false);
  clock.fire();
  fake.emit("sessionLocked");
  expect(fake.published).toEqual([]);
});

// Implementation detail, not a public promise: the system event service does not guarantee subscriber order.
test("the adapter subscribes lifecycle before status so a resume reaches power.resumed first in this host", () => {
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
