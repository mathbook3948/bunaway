import { expect, test } from "bun:test";
import { SystemEvents } from "#native/windows/bun/system-events";
import { statusSchema } from "#plugins/power/src/contract";

const WM_POWERBROADCAST = 0x0218;
const PBT_APMPOWERSTATUSCHANGE = 0x0an;
const PBT_APMRESUMEAUTOMATIC = 0x12n;

/**
 * A real hidden notification HWND owned by a real SystemEvents service. Messages are sent
 * synchronously with a scalar wparam, then delivered to plugins by pump and flush.
 * CI runners have no battery, so a real AC plug or unplug transition is not verified here.
 */
async function harness() {
  const [{ Windows }, { user, disposeWin32Bindings }, { dlopen }] =
    await Promise.all([
      import("#native/windows/bun/win32"),
      import("#native/windows/bun/win32-bindings"),
      import("bun:ffi"),
    ]);
  const windows = new Windows(() => {});
  const driver = dlopen("user32.dll", {
    SendMessageW: {
      args: [
        "u64",
        "u32",
        "u64",
        "i64",
      ],
      returns: "i64",
    },
  });
  let hwnd: bigint | undefined;
  const published: unknown[][] = [];
  const failures: unknown[] = [];
  const service = new SystemEvents({
    open: (receive) => {
      hwnd = windows.create(
        "Bunaway power status regression",
        200,
        200,
        receive,
        false,
      );
      const owner = hwnd;
      return () => {
        windows.destroy(owner);
      };
    },
    sessions: () => {},
    publish: (...args) => {
      published.push(args);
    },
    report: (error) => failures.push(error),
  });
  return {
    service,
    published,
    failures,
    /** The window acquired by the first subscription. */
    get hwnd() {
      if (!hwnd) {
        throw new Error("notification window missing");
      }
      return hwnd;
    },
    windowExists: (window: bigint) => user.symbols.IsWindow(window) !== 0,
    /** Deliver one power broadcast to the notification window and run plugin callbacks. */
    broadcast(window: bigint, code = PBT_APMPOWERSTATUSCHANGE) {
      this.send(window, WM_POWERBROADCAST, code);
    },
    /** Deliver any window message with a scalar wparam, then run plugin callbacks. */
    send(window: bigint, message: number, wparam: bigint) {
      driver.symbols.SendMessageW(window, message, wparam, 0n);
      windows.pump();
      service.flush();
    },
    dispose() {
      service.dispose();
      windows.dispose();
      driver.close();
      disposeWin32Bindings();
    },
  };
}

test.skipIf(process.platform !== "win32")(
  "power plugin initialization subscribes to the real notification HWND and publishes only valid status snapshots",
  async () => {
    const [{ WindowsPower }, { createPower }] = await Promise.all([
      import("#plugins/power/src/platforms/windows"),
      import("#plugins/power/src/platforms/windows-bindings"),
    ]);
    const h = await harness();
    const reference = createPower();
    try {
      const before = JSON.stringify(reference.status());
      // The constructor is the real init path; initialize only forwards windows.systemEvents.
      const instance = new WindowsPower(h.service);
      try {
        const window = h.hwnd;
        expect(h.windowExists(window)).toBe(true);
        h.broadcast(window);
        const beforeResume = h.published.length;
        h.broadcast(window, PBT_APMRESUMEAUTOMATIC);
        const after = JSON.stringify(reference.status());
        // The resume broadcast also publishes the payload-free lifecycle event.
        const statusEvents = h.published.filter(
          ([event]) => event === "power.statusChanged",
        );
        for (const [event, payload, operation] of statusEvents) {
          expect(event).toBe("power.statusChanged");
          expect(operation).toBe("power.getStatus");
          expect(statusSchema.safeParse(payload).success).toBe(true);
        }
        // Relative order against power.statusChanged is not a contract, so only count the event.
        const resumed = h.published
          .slice(beforeResume)
          .filter(([event]) => event === "power.resumed");
        expect(resumed).toEqual([
          [
            "power.resumed",
            {},
            "power.getStatus",
          ],
        ]);
        // Without a genuine change between the surrounding reads, the broadcast must stay silent.
        if (before === after) {
          expect(statusEvents).toEqual([]);
        }
        expect(h.failures).toEqual([]);
      } finally {
        instance.dispose();
      }
      expect(h.windowExists(h.hwnd)).toBe(false);
    } finally {
      reference.dispose();
      h.dispose();
    }
  },
);

test.skipIf(process.platform !== "win32")(
  "each delivered power status broadcast re-reads the real status once and unrelated messages do not",
  async () => {
    const [{ watchPowerStatus }, { createPower }] = await Promise.all([
      import("#plugins/power/src/platforms/windows-status-events"),
      import("#plugins/power/src/platforms/windows-bindings"),
    ]);
    const h = await harness();
    const native = createPower();
    let reads = 0;
    try {
      const release = watchPowerStatus(() => {
        reads++;
        return native.status();
      }, h.service);
      expect(release).toBeDefined();
      expect(reads).toBe(1);
      const window = h.hwnd;
      for (let count = 2; count <= 4; count++) {
        h.broadcast(window);
        expect(reads).toBe(count);
      }
      // PBT_APMSUSPEND is a different broadcast and does not refresh the status.
      h.broadcast(window, 4n);
      expect(reads).toBe(4);
      release?.();
    } finally {
      native.dispose();
      h.dispose();
    }
  },
);

test.skipIf(process.platform !== "win32")(
  "a changed status read after a real broadcast is published once with the status read grant",
  async () => {
    const { watchPowerStatus } = await import(
      "#plugins/power/src/platforms/windows-status-events"
    );
    const h = await harness();
    const initial = statusSchema.parse({
      source: "ac",
      batteryPresent: true,
      charging: true,
      batteryPercent: 100,
      batterySaver: false,
      remainingSeconds: null,
      fullLifeSeconds: null,
    });
    const changed = statusSchema.parse({
      ...initial,
      source: "battery",
      charging: false,
      batteryPercent: 99,
      remainingSeconds: 3600,
    });
    let current = initial;
    try {
      const release = watchPowerStatus(
        () => structuredClone(current),
        h.service,
      );
      const window = h.hwnd;
      h.broadcast(window);
      expect(h.published).toEqual([]);
      current = changed;
      h.broadcast(window);
      h.broadcast(window);
      expect(h.published).toEqual([
        [
          "power.statusChanged",
          changed,
          "power.getStatus",
        ],
      ]);
      expect(statusSchema.parse(h.published[0]?.[1])).toEqual(changed);
      release?.();
    } finally {
      h.dispose();
    }
  },
);

test.skipIf(process.platform !== "win32")(
  "releasing the subscription destroys the notification HWND and later messages are not delivered",
  async () => {
    const { watchPowerStatus } = await import(
      "#plugins/power/src/platforms/windows-status-events"
    );
    const h = await harness();
    let reads = 0;
    let current = 0;
    try {
      const release = watchPowerStatus(() => {
        reads++;
        return statusSchema.parse({
          source: "ac",
          batteryPresent: true,
          charging: true,
          batteryPercent: current,
          batterySaver: false,
          remainingSeconds: null,
          fullLifeSeconds: null,
        });
      }, h.service);
      const window = h.hwnd;
      expect(h.windowExists(window)).toBe(true);
      release?.();
      release?.();
      expect(h.windowExists(window)).toBe(false);
      current = 50;
      // A message to the destroyed window is ignored by the OS and cannot reach the plugin.
      h.broadcast(window);
      expect(reads).toBe(1);
      expect(h.published).toEqual([]);
      expect(h.failures).toEqual([]);
    } finally {
      h.dispose();
    }
  },
);

const WM_WTSSESSION_CHANGE = 0x02b1;
const PBT_APMSUSPEND = 0x04n;
const WTS_SESSION_LOCK = 7n;
const WTS_SESSION_UNLOCK = 8n;
const WTS_SESSION_LOGON = 5n;

test.skipIf(process.platform !== "win32")(
  "synthetic suspend, resume and WTS lock messages publish ordered empty lifecycle events until released while the window stays alive",
  async () => {
    const { watchPowerLifecycle } = await import(
      "#plugins/power/src/platforms/windows-lifecycle-events"
    );
    const h = await harness();
    try {
      const release = watchPowerLifecycle(h.service);
      // A second subscriber keeps the notification window alive after the lifecycle release.
      const keepAlive = h.service.subscribe(() => {});
      const window = h.hwnd;
      h.broadcast(window, PBT_APMSUSPEND);
      h.broadcast(window, PBT_APMRESUMEAUTOMATIC);
      h.send(window, WM_WTSSESSION_CHANGE, WTS_SESSION_LOCK);
      h.send(window, WM_WTSSESSION_CHANGE, WTS_SESSION_UNLOCK);
      // A status broadcast and an unrelated WTS code are not lifecycle events.
      h.broadcast(window);
      h.send(window, WM_WTSSESSION_CHANGE, WTS_SESSION_LOGON);
      expect(h.published).toEqual(
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
      release?.();
      release?.();
      expect(h.windowExists(window)).toBe(true);
      const publishedBefore = h.published.length;
      h.broadcast(window, PBT_APMSUSPEND);
      h.broadcast(window, PBT_APMRESUMEAUTOMATIC);
      h.send(window, WM_WTSSESSION_CHANGE, WTS_SESSION_LOCK);
      expect(h.published).toHaveLength(publishedBefore);
      keepAlive();
      expect(h.windowExists(window)).toBe(false);
      expect(h.failures).toEqual([]);
    } finally {
      h.dispose();
    }
  },
);

test.skipIf(process.platform !== "win32")(
  "a failing status subscription rolls back the lifecycle subscriptions and releases native resources",
  async () => {
    const { WindowsPower } = await import(
      "#plugins/power/src/platforms/windows"
    );
    let subscriptions = 0;
    let released = 0;
    const systemEvents = {
      subscribe: () => {
        // Lifecycle takes two subscriptions first, the status watcher is the third.
        if (++subscriptions === 3) {
          throw new Error("status subscription failed");
        }
        return () => {
          released++;
        };
      },
      publish: () => {},
    };
    expect(() => new WindowsPower(systemEvents)).toThrow(
      "status subscription failed",
    );
    expect(subscriptions).toBe(3);
    expect(released).toBe(2);
  },
);
