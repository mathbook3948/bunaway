import { expect, test } from "bun:test";
import {
  DesktopRequests,
  type MacosQuitRequestReason,
} from "#native/macos/bun/desktop-requests";

function requests(stopping = () => false) {
  const sent: MacosQuitRequestReason[] = [];
  const opened: (readonly string[])[] = [];
  /** Every reopen delivery in order, with the `hasVisibleWindows` it carried. */
  const reopened: boolean[] = [];
  /** Every delivery of either kind in the order the backend would see it. */
  const order: string[] = [];
  let reopenInFlight = 0;
  let maxReopenInFlight = 0;
  const diagnostics: {
    event: string;
    fields: object;
  }[] = [];
  /** Settles the `sendOpenUrls` calls in order; by default each is accepted at once. */
  let acceptOpenUrls: (() => Promise<void>) | undefined;
  /** Settles the `deliverReopen` calls in order; by default each is accepted at once. */
  let acceptReopen: (() => Promise<void>) | undefined;
  return {
    sent,
    opened,
    reopened,
    order,
    maxReopenInFlight: () => maxReopenInFlight,
    holdReopen(hold: () => Promise<void>) {
      acceptReopen = hold;
    },
    diagnostics,
    holdOpenUrls(hold: () => Promise<void>) {
      acceptOpenUrls = hold;
    },
    desktop: new DesktopRequests({
      stopping,
      sendQuitRequest: (reason) => sent.push(reason),
      sendOpenUrls: async (urls) => {
        opened.push(urls);
        order.push(`open:${urls.join(",")}`);
        await acceptOpenUrls?.();
      },
      deliverReopen: async (hasVisibleWindows) => {
        reopened.push(hasVisibleWindows);
        order.push(`reopen:${hasVisibleWindows}`);
        reopenInFlight++;
        maxReopenInFlight = Math.max(maxReopenInFlight, reopenInFlight);
        try {
          await acceptReopen?.();
        } finally {
          reopenInFlight--;
        }
      },
      diagnostic: (event, fields) =>
        diagnostics.push({
          event,
          fields,
        }),
    }),
  };
}
const config = {
  closeBehavior: "quit",
  reopenHandler: false,
} as const;

test("requests that arrive before the backend's options wait for them and collapse per key", async () => {
  const { desktop } = requests();
  const runs: string[] = [];
  expect(desktop.closeBehavior).toBeUndefined();
  desktop.defer("quit-command", () => runs.push("quit"));
  desktop.defer("quit-command", () => runs.push("quit again"));
  desktop.defer("show", () => runs.push("show"));
  expect(runs).toEqual([]);
  desktop.configure({
    closeBehavior: "keep-alive",
    reopenHandler: true,
  });
  await desktop.configured();
  expect(runs).toEqual([
    "quit",
    "show",
  ]);
  expect(desktop.closeBehavior).toBe("keep-alive");
  expect(desktop.reopenHandler).toBe(true);
  // Once the options are known requests run at once, and the first options stay.
  desktop.defer("quit-command", () => runs.push("late"));
  desktop.configure(config);
  expect(runs.at(-1)).toBe("late");
  expect(desktop.closeBehavior).toBe("keep-alive");
});

test("a deferred request is dropped when shutdown began before the options arrived", async () => {
  let stopping = false;
  const { desktop } = requests(() => stopping);
  const runs: string[] = [];
  desktop.defer("show", () => runs.push("show"));
  stopping = true;
  desktop.abandon();
  expect(await desktop.configured()).toBeUndefined();
  expect(runs).toEqual([]);
});

test("one quit request is pending at a time and a veto allows the next", async () => {
  const { desktop, sent } = requests();
  desktop.configure(config);
  const first = desktop.requestQuit("last-window");
  // A Quit command while the last-window request waits joins it instead of sending another.
  const joined = desktop.requestQuit("quit-command");
  expect(sent).toEqual([
    "last-window",
  ]);
  expect(desktop.quitPending).toBe(true);
  desktop.quitCancelled();
  await Promise.all([
    first,
    joined,
  ]);
  expect(desktop.quitPending).toBe(false);
  void desktop.requestQuit("quit-command");
  expect(sent).toEqual([
    "last-window",
    "quit-command",
  ]);
});

test("shutdown settles a pending quit request and later requests send nothing", async () => {
  let stopping = false;
  const { desktop, sent } = requests(() => stopping);
  desktop.configure(config);
  const pending = desktop.requestQuit("last-window");
  stopping = true;
  desktop.abandon();
  await pending;
  expect(desktop.quitPending).toBe(false);
  await desktop.requestQuit("quit-command");
  expect(sent).toEqual([
    "last-window",
  ]);
  // Repeating the shutdown notice is harmless.
  desktop.abandon();
});

/** Lets the drain loop's promise continuations run. */
const settle = () => Bun.sleep(0);

test("open requests wait for the options, never collapse and reach the backend in order", async () => {
  const { desktop, opened } = requests();
  desktop.openUrls([
    "a:1",
  ]);
  desktop.openUrls([
    "a:2",
    "a:3",
  ]);
  desktop.openUrls([
    "a:1",
  ]);
  await settle();
  expect(opened).toEqual([]);
  desktop.configure(config);
  await settle();
  expect(opened).toEqual([
    [
      "a:1",
    ],
    [
      "a:2",
      "a:3",
    ],
    [
      "a:1",
    ],
  ]);
});

test("the next open request is sent only after the previous one was accepted", async () => {
  const { desktop, opened, holdOpenUrls } = requests();
  const gates = [
    Promise.withResolvers<void>(),
    Promise.withResolvers<void>(),
  ];
  let call = 0;
  holdOpenUrls(() => gates[call++]?.promise ?? Promise.resolve());
  desktop.configure(config);
  desktop.openUrls([
    "a:1",
  ]);
  desktop.openUrls([
    "a:2",
  ]);
  await settle();
  expect(opened).toHaveLength(1);
  gates[0]?.resolve();
  await settle();
  expect(opened).toHaveLength(2);
  gates[1]?.resolve();
});

test("open requests beyond the bound are dropped with a diagnostic and the rest stay in order", async () => {
  const { desktop, opened, diagnostics } = requests();
  for (let index = 0; index < 20; index++) {
    desktop.openUrls([
      `a:${index}`,
    ]);
  }
  expect(diagnostics.map((entry) => entry.event)).toEqual(
    Array(4).fill("open-urls-dropped"),
  );
  expect(diagnostics[0]?.fields).toEqual({
    reason: "queue-full",
    count: 1,
  });
  desktop.configure(config);
  await settle();
  expect(opened.map((urls) => urls[0])).toEqual(
    Array.from(
      {
        length: 16,
      },
      (_, index) => `a:${index}`,
    ),
  );
});

test("shutdown discards queued open requests and later ones", async () => {
  let stopping = false;
  const { desktop, opened } = requests(() => stopping);
  desktop.openUrls([
    "a:1",
  ]);
  stopping = true;
  desktop.abandon();
  desktop.openUrls([
    "a:2",
  ]);
  await settle();
  expect(opened).toEqual([]);
});

test("a request is not taken from the queue once stopping began during an earlier send", async () => {
  let stopping = false;
  const { desktop, opened, holdOpenUrls } = requests(() => stopping);
  holdOpenUrls(async () => {
    stopping = true;
  });
  desktop.configure(config);
  desktop.openUrls([
    "a:1",
  ]);
  desktop.openUrls([
    "a:2",
  ]);
  await settle();
  expect(opened).toEqual([
    [
      "a:1",
    ],
  ]);
  // Stopping is final in production; clearing it here shows a:2 stayed queued instead of being
  // taken and discarded, so the next drain still delivers it ahead of a:3.
  stopping = false;
  holdOpenUrls(async () => {});
  desktop.openUrls([
    "a:3",
  ]);
  await settle();
  expect(opened.map((urls) => urls[0])).toEqual([
    "a:1",
    "a:2",
    "a:3",
  ]);
});

test("a failed send is reported and does not block the next open request", async () => {
  const { desktop, opened, diagnostics, holdOpenUrls } = requests();
  let failNext = true;
  holdOpenUrls(async () => {
    if (failNext) {
      failNext = false;
      throw new Error("channel closed");
    }
  });
  desktop.configure(config);
  desktop.openUrls([
    "a:1",
  ]);
  desktop.openUrls([
    "a:2",
  ]);
  await settle();
  expect(opened).toHaveLength(2);
  expect(diagnostics).toEqual([
    {
      event: "open-urls-dropped",
      fields: {
        reason: "send-failed",
        count: 1,
        message: "channel closed",
      },
    },
  ]);
});

test("reopens before the options arrive merge and deliver the latest value once", async () => {
  const { desktop, reopened } = requests();
  desktop.reopen(false);
  desktop.reopen(true);
  desktop.reopen(false);
  await settle();
  expect(reopened).toEqual([]);
  desktop.configure(config);
  await settle();
  expect(reopened).toEqual([
    false,
  ]);
});

test("a burst of reopens during a slow delivery sends one in flight plus one merged", async () => {
  const { desktop, reopened, diagnostics, holdReopen, maxReopenInFlight } =
    requests();
  const gate = Promise.withResolvers<void>();
  let call = 0;
  holdReopen(() => (call++ === 0 ? gate.promise : Promise.resolve()));
  desktop.configure(config);
  desktop.reopen(true);
  await settle();
  for (let count = 0; count < 100; count++) {
    desktop.reopen(count % 2 === 0);
  }
  await settle();
  expect(reopened).toEqual([
    true,
  ]);
  gate.resolve();
  await settle();
  // The last of the 100 calls has count 99, so hasVisibleWindows is false.
  expect(reopened).toEqual([
    true,
    false,
  ]);
  expect(maxReopenInFlight()).toBe(1);
  expect(diagnostics).toEqual([]);
});

test("open and reopen requests keep arrival order and only adjacent reopens merge", async () => {
  const { desktop, order } = requests();
  desktop.openUrls([
    "a:A",
  ]);
  desktop.reopen(true);
  desktop.openUrls([
    "a:B",
  ]);
  desktop.reopen(false);
  desktop.reopen(true);
  desktop.configure(config);
  await settle();
  expect(order).toEqual([
    "open:a:A",
    "reopen:true",
    "open:a:B",
    "reopen:true",
  ]);
});

test("reopen requests do not count against the open request bound", async () => {
  const { desktop, opened, reopened, diagnostics } = requests();
  for (let index = 0; index < 16; index++) {
    desktop.openUrls([
      `a:${index}`,
    ]);
    desktop.reopen(index % 2 === 0);
  }
  expect(diagnostics).toEqual([]);
  desktop.configure(config);
  await settle();
  expect(opened).toHaveLength(16);
  expect(reopened).toHaveLength(16);
});

test("a failed reopen delivery is reported and the next request still runs", async () => {
  const { desktop, opened, diagnostics, holdReopen } = requests();
  holdReopen(async () => {
    throw new Error("channel closed");
  });
  desktop.configure(config);
  desktop.reopen(true);
  desktop.openUrls([
    "a:1",
  ]);
  await settle();
  expect(opened).toHaveLength(1);
  expect(diagnostics).toEqual([
    {
      event: "reopen-dropped",
      fields: {
        reason: "send-failed",
        message: "channel closed",
      },
    },
  ]);
});
