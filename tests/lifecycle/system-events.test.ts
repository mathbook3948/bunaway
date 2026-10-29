import { expect, test } from "bun:test";
import type { Policy } from "@bunaway/protocol";
import {
  publishSystemEvent,
  SystemEvents,
} from "#native/windows/bun/system-events";

test("system notification owner is lazy, coalesces after pump and survives subscriber failures", () => {
  let receive: ((message: number, wparam: bigint) => void) | undefined;
  let opens = 0;
  let closes = 0;
  const errors: unknown[] = [];
  const service = new SystemEvents({
    open: (callback) => {
      opens++;
      receive = callback;
      return () => {
        closes++;
      };
    },
    sessions: () => {},
    publish: () => {},
    report: (error) => errors.push(error),
  });
  expect(opens).toBe(0);
  const failing = service.subscribe(() => {
    throw new Error("query failed");
  });
  const seen: string[] = [];
  const release = service.subscribe((signal) => seen.push(signal));
  expect(opens).toBe(1);
  receive?.(0x001a, 0n);
  receive?.(0x001a, 0n);
  receive?.(0x0320, 0n);
  receive?.(0xffff, 0n);
  expect(seen).toEqual([]);
  service.flush();
  expect(seen).toEqual([
    "settingChanged",
    "accentChanged",
  ]);
  expect(errors).toHaveLength(2);
  failing();
  failing();
  expect(closes).toBe(0);
  receive?.(0x0015, 0n);
  service.flush();
  expect(seen.at(-1)).toBe("colorsChanged");
  release();
  release();
  expect(closes).toBe(1);
  const again = service.subscribe(() => {});
  expect(opens).toBe(2);
  service.dispose();
  service.dispose();
  again();
  expect(closes).toBe(2);
  expect(() => service.subscribe(() => {})).toThrow("disposed");
});

test("subscription changes during flush respect removal and defer reentrant invalidations", () => {
  let receive: ((message: number, wparam: bigint) => void) | undefined;
  const service = new SystemEvents({
    open: (callback) => {
      receive = callback;
      return () => {};
    },
    sessions: () => {},
    publish: () => {},
    report: () => {},
  });
  let second = () => {};
  const seen: string[] = [];
  service.subscribe((signal) => {
    seen.push(signal);
    second();
    receive?.(0x031a, 0n);
  });
  second = service.subscribe(() => seen.push("removed"));
  receive?.(0x001a, 0n);
  service.flush();
  expect(seen).toEqual([
    "settingChanged",
  ]);
  service.flush();
  expect(seen).toEqual([
    "settingChanged",
    "themeChanged",
  ]);
  service.dispose();
});

test("failed notification creation does not retain subscriptions and disposal stops publication", () => {
  let attempts = 0;
  let publications = 0;
  const service = new SystemEvents({
    open: () => {
      if (++attempts === 1) {
        throw new Error("native failure");
      }
      return () => {};
    },
    sessions: () => {},
    publish: () => {
      publications++;
    },
    report: () => {},
  });
  expect(() => service.subscribe(() => {})).toThrow("native failure");
  const release = service.subscribe(() => {});
  expect(attempts).toBe(2);
  service.publish("plugin.changed", null, "plugin.read");
  expect(publications).toBe(1);
  service.dispose();
  release();
  service.publish("plugin.changed", null, "plugin.read");
  expect(publications).toBe(1);
});

test("power and session lifecycle edges retain order while status notifications coalesce", () => {
  let receive: ((message: number, wparam: bigint) => void) | undefined;
  const registrations: boolean[] = [];
  const service = new SystemEvents({
    open: (callback) => {
      receive = callback;
      return () => {};
    },
    sessions: (enable) => registrations.push(enable),
    publish: () => {},
    report: () => {},
  });
  const seen: string[] = [];
  const appearance = service.subscribe(() => {});
  receive?.(0x02b1, 7n);
  const release = service.subscribe((signal) => seen.push(signal), {
    sessionNotifications: true,
  });
  const second = service.subscribe(() => {}, {
    sessionNotifications: true,
  });
  for (const code of [
    4n,
    0x12n,
    7n,
    4n,
    0xan,
    0xan,
  ]) {
    receive?.(0x0218, code);
  }
  for (const code of [
    7n,
    8n,
    7n,
  ]) {
    receive?.(0x02b1, code);
  }
  service.flush();
  expect(seen).toEqual([
    "suspend",
    "resume",
    "suspend",
    "powerStatusChanged",
    "sessionLocked",
    "sessionUnlocked",
    "sessionLocked",
  ]);
  release();
  expect(registrations).toEqual([
    true,
  ]);
  second();
  expect(registrations).toEqual([
    true,
    false,
  ]);
  appearance();
  service.dispose();
});

test("automatic resume emits once across pump batches and interleaved user-presence notifications", () => {
  const WM_POWERBROADCAST = 0x0218;
  const WM_SETTINGCHANGE = 0x001a;
  const WM_SYSCOLORCHANGE = 0x0015;
  const PBT_APMSUSPEND = 4n;
  const PBT_APMRESUMEAUTOMATIC = 0x12n;
  const PBT_APMRESUMESUSPEND = 7n;
  let receive: ((message: number, wparam: bigint) => void) | undefined;
  const service = new SystemEvents({
    open(callback) {
      receive = callback;
      return () => {};
    },
    sessions() {},
    publish() {},
    report() {},
  });
  const seen: string[] = [];
  service.subscribe((signal) => seen.push(signal));
  try {
    // Unattended wake resumes first; user activity can arrive in a later pump batch.
    receive?.(WM_POWERBROADCAST, PBT_APMSUSPEND);
    receive?.(WM_POWERBROADCAST, PBT_APMRESUMEAUTOMATIC);
    service.flush();
    expect(seen).toEqual([
      "suspend",
      "resume",
    ]);
    receive?.(WM_POWERBROADCAST, PBT_APMRESUMESUSPEND);
    service.flush();
    expect(seen).toEqual([
      "suspend",
      "resume",
    ]);
    // An unrelated setting between the two native resume messages also cannot duplicate a wake.
    receive?.(WM_POWERBROADCAST, PBT_APMSUSPEND);
    receive?.(WM_POWERBROADCAST, PBT_APMRESUMEAUTOMATIC);
    receive?.(WM_SETTINGCHANGE, 0n);
    receive?.(WM_POWERBROADCAST, PBT_APMRESUMESUSPEND);
    service.flush();
    expect(seen).toEqual([
      "suspend",
      "resume",
      "suspend",
      "resume",
      "settingChanged",
    ]);
    // Preserve later real cycles, including a wake with no user-presence follow-up.
    receive?.(WM_POWERBROADCAST, PBT_APMSUSPEND);
    service.flush();
    receive?.(WM_POWERBROADCAST, PBT_APMRESUMEAUTOMATIC);
    receive?.(WM_SYSCOLORCHANGE, 0n);
    service.flush();
    receive?.(WM_POWERBROADCAST, PBT_APMRESUMESUSPEND);
    service.flush();
    expect(seen).toEqual([
      "suspend",
      "resume",
      "suspend",
      "resume",
      "settingChanged",
      "suspend",
      "resume",
      "colorsChanged",
    ]);
  } finally {
    service.dispose();
  }
});

test("session registration failure unwinds the notification window and lifecycle overflow is explicit", () => {
  let closed = 0;
  let receive: ((message: number, wparam: bigint) => void) | undefined;
  const service = new SystemEvents({
    open: (callback) => {
      receive = callback;
      return () => {
        closed++;
      };
    },
    sessions: () => {
      throw new Error("WTS unavailable");
    },
    publish: () => {},
    report: () => {},
  });
  expect(() =>
    service.subscribe(() => {}, {
      sessionNotifications: true,
    }),
  ).toThrow("WTS unavailable");
  expect(closed).toBe(1);
  service.subscribe(() => {});
  for (let index = 0; index < 129; index++) {
    receive?.(0x0218, index % 2 === 0 ? 4n : 0x12n);
  }
  expect(() => service.flush()).toThrow("queue full");
  service.dispose();
  expect(closed).toBe(2);
});

test("publication requires a registered read operation, a current event route and recipient read authority", () => {
  const operation = "test.read";
  const recipients = [
    {
      id: "allowed",
      policy: {
        host: {
          permissions: [
            operation,
          ],
        },
      },
      eventRoute: () => true,
    },
    {
      id: "unsubscribed",
      policy: {
        host: {
          permissions: [
            operation,
          ],
        },
      },
      eventRoute: () => false,
    },
    {
      id: "read-denied",
      policy: {
        host: {
          permissions: [],
        },
      },
      eventRoute: () => true,
    },
  ];
  const sent: string[] = [];
  const registry = {
    operations: new Map([
      [
        operation,
        {
          name: operation,
          input: {
            type: "null",
          },
          output: {
            type: "null",
          },
        },
      ],
    ]),
    allowed: (
      policy: Policy["backend"],
      call: {
        operation: string;
      },
    ) => policy.permissions.includes(call.operation),
  };
  publishSystemEvent(
    registry,
    recipients,
    "test.changed",
    null,
    operation,
    (recipient) => sent.push(recipient.id),
  );
  expect(sent).toEqual([
    "allowed",
  ]);
  const allowed = recipients[0];
  if (!allowed) {
    throw new Error("Missing recipient fixture.");
  }
  allowed.eventRoute = () => false;
  publishSystemEvent(
    registry,
    recipients,
    "test.changed",
    null,
    operation,
    (recipient) => sent.push(recipient.id),
  );
  publishSystemEvent(
    registry,
    recipients,
    "test.changed",
    null,
    "unknown.read",
    (recipient) => sent.push(recipient.id),
  );
  expect(sent).toEqual([
    "allowed",
  ]);
  // Without a required operation only the live subscription decides, so the recipient that lacks
  // the read grant also receives the event.
  sent.length = 0;
  publishSystemEvent(
    registry,
    recipients,
    "test.changed",
    null,
    null,
    (recipient) => sent.push(recipient.id),
  );
  expect(sent).toEqual([
    "read-denied",
  ]);
});

test("failed WTS unregister and native destruction remain retryable through their owning disposer", () => {
  let unregisters = 0;
  let destroys = 0;
  const service = new SystemEvents({
    open: () => () => {
      if (++destroys === 1) {
        throw new Error("destroy failed");
      }
    },
    sessions: (enable) => {
      if (!enable && ++unregisters === 1) {
        throw new Error("unregister failed");
      }
    },
    publish: () => {},
    report: () => {},
  });
  const appearance = service.subscribe(() => {});
  const power = service.subscribe(() => {}, {
    sessionNotifications: true,
  });
  expect(() => power()).toThrow("unregister failed");
  power();
  expect(unregisters).toBe(2);
  expect(() => appearance()).toThrow("destroy failed");
  appearance();
  appearance();
  expect(destroys).toBe(2);
  service.dispose();
});
