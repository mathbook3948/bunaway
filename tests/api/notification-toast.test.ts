import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import notification from "@bunaway/plugin-notification";
import {
  BunawayError,
  type JsonValue,
  NativeRegistry,
} from "@bunaway/protocol";
import { publishSystemEvent } from "#native/windows/bun/system-events";
import {
  MAX_ACTIVE_TOASTS,
  MAX_EXPIRES_AFTER_SECONDS,
  type NotificationResult,
  notificationScheduleSchema,
  notificationShowSchema,
  type ToastEvent,
} from "#plugins/notification/src/contract";
import { notificationOperations } from "#plugins/notification/src/operations";
import {
  createToastController,
  type ToastDriver,
  toastXml,
} from "#plugins/notification/src/platforms/toast-controller";
import { pluginParsers } from "../fixtures/plugin-parsers.ts";

const parsers = pluginParsers("notification", notificationOperations);
const registry = new NativeRegistry([
  notification._definition,
]);
const input = (id = "example") =>
  notificationShowSchema.parse({
    id,
    title: "Hello",
  });

function fixture() {
  const callbacks: ((event: ToastEvent) => void)[] = [];
  const cleared: string[] = [];
  const detached: number[] = [];
  const events: {
    event: string;
    payload: JsonValue;
  }[] = [];
  let failShow = false,
    failClear = false,
    failDetach = false,
    clearedAll = 0,
    clearedGroups: string[] = [],
    disposals = 0;
  let listed: NotificationResult[] = [];
  const driver: ToastDriver = {
    show(_input, receive) {
      if (failShow) {
        throw new Error("show failed");
      }
      const index = callbacks.push(receive) - 1;
      return {
        detach() {
          if (failDetach) {
            throw new Error("detach failed");
          }
          detached.push(index);
        },
      };
    },
    clear(identity) {
      if (failClear) {
        throw new Error("clear failed");
      }
      cleared.push(`${identity.group}/${identity.id}`);
    },
    list() {
      return listed;
    },
    schedule() {},
    listScheduled: () => [],
    cancelScheduled() {},
    clearGroup(group) {
      if (failClear) {
        throw new Error("clear failed");
      }
      clearedGroups.push(group);
    },
    clearAll() {
      if (failClear) {
        throw new Error("clear failed");
      }
      clearedAll++;
    },
    dispose() {
      disposals++;
    },
  };
  const controller = createToastController(driver, (event, payload) =>
    events.push({
      event,
      payload,
    }),
  );
  return {
    controller,
    callbacks,
    events,
    cleared,
    clearedGroups,
    detached,
    setListed(items: NotificationResult[]) {
      listed = items;
    },
    failure(kind: "show" | "clear" | "detach", value: boolean) {
      if (kind === "show") {
        failShow = value;
      }
      if (kind === "clear") {
        failClear = value;
      }
      if (kind === "detach") {
        failDetach = value;
      }
    },
    get clearedAll() {
      return clearedAll;
    },
    get disposals() {
      return disposals;
    },
  };
}

test("toast inputs reject XML controls, lone surrogates, external identity/routes and unbounded content", async () => {
  const valid = await parsers.validateCall({
    operation: "notification.show",
    payload: {
      id: "first",
      title: "안녕 🚀\n<&>",
    },
  });
  expect(valid.payload).toEqual({
    ...input("first"),
    title: "안녕 🚀\n<&>",
  });
  const bad: JsonValue[] = [
    {
      id: "valid\n",
      title: "hello",
    },
    null,
    {},
    {
      id: "",
      title: "hello",
    },
    {
      id: "x".repeat(17),
      title: "hello",
    },
    {
      id: "valid",
      title: "",
    },
    {
      id: "valid",
      title: "bad\0",
    },
    {
      id: "valid",
      title: "\ud800",
    },
    {
      id: "valid",
      title: "ok",
      body: "\uffff",
    },
    {
      id: "valid",
      title: "x".repeat(257),
    },
    {
      id: "valid",
      title: "ok",
      body: "x".repeat(2049),
    },
    {
      id: "valid",
      title: "ok",
      data: "x".repeat(2049),
    },
    {
      id: "valid",
      title: "ok",
      appUserModelId: "other.app",
    },
    {
      id: "valid",
      title: "ok",
      launch: "file:///bad",
    },
    {
      id: "valid",
      title: "ok",
      xml: "<toast/>",
    },
    {
      id: "valid",
      group: "../other",
      title: "ok",
    },
  ];
  for (const payload of bad) {
    await expect(
      parsers.validateCall({
        operation: "notification.show",
        payload,
      }),
    ).rejects.toThrow();
  }
  await expect(
    parsers.validateCall({
      operation: "notification.clear",
      payload: {
        id: "valid",
        all: true,
      },
    }),
  ).rejects.toThrow();
  await expect(
    parsers.validateOutput("notification.show", {
      id: "first",
      group: "bunaway",
      displayed: true,
    }),
  ).rejects.toThrow();
});

test("show and clear require separate grants; live toast events require show and a current event route", () => {
  const recipients = [
    {
      id: "allowed",
      policy: {
        host: {
          permissions: [
            "notification.show",
          ],
        },
      },
      eventRoute: () => true,
    },
    {
      id: "clear-only",
      policy: {
        host: {
          permissions: [
            "notification.clear",
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
            "notification.show",
          ],
        },
      },
      eventRoute: () => false,
    },
  ];
  expect(
    registry.allowed(
      {
        permissions: [
          "notification.show",
        ],
      },
      {
        operation: "notification.clear",
        payload: {
          id: "first",
        },
      },
    ),
  ).toBe(false);
  const sent: string[] = [];
  publishSystemEvent(
    registry,
    recipients,
    "notification.clicked",
    {
      id: "first",
      group: "bunaway",
      data: null,
    },
    "notification.show",
    (recipient) => sent.push(recipient.id),
  );
  expect(sent).toEqual([
    "allowed",
  ]);
  expect(notification._definition.nativePlatforms.windows?.thread).toBe("ui");
  expect(notification._definition.nativePlatforms.macos).toBeUndefined();
});

test("toast XML treats content as text and never includes app data as activation markup", () => {
  const value = notificationShowSchema.parse({
    id: "first",
    title: "<text>&\"' 🚀",
    body: '</text><audio src="evil"/>',
    data: "file:///not-a-route",
    silent: true,
  });
  expect(toastXml(value)).toBe(
    '<toast launch="bunaway1;bunaway;first;"><visual><binding template="ToastGeneric"><text>&lt;text&gt;&amp;&quot;&apos; 🚀</text><text>&lt;/text&gt;&lt;audio src=&quot;evil&quot;/&gt;</text></binding></visual><audio silent="true"/></toast>',
  );
  expect(toastXml(input())).not.toContain("audio");
});

test("timeoutType never selects the reminder scenario and keeps a dismiss button", () => {
  const parse = (extra: Record<string, unknown>) =>
    notificationShowSchema.parse({
      id: "reminder",
      title: "Hello",
      ...extra,
    });
  expect(toastXml(input())).not.toContain("scenario");
  expect(
    toastXml(
      parse({
        timeoutType: "default",
      }),
    ),
  ).not.toContain("scenario");
  // Without buttons the system dismiss action (empty content, localized label) keeps the reminder visible.
  expect(
    toastXml(
      parse({
        timeoutType: "never",
      }),
    ),
  ).toBe(
    '<toast launch="bunaway1;bunaway;reminder;" scenario="reminder"><visual><binding template="ToastGeneric"><text>Hello</text><text></text></binding></visual><actions><action content="" arguments="dismiss" activationType="system"/></actions></toast>',
  );
  // The app's own buttons already satisfy the reminder, so no extra dismiss button is added.
  const withAction = toastXml(
    parse({
      timeoutType: "never",
      actions: [
        {
          id: "snooze",
          label: "Snooze",
        },
      ],
    }),
  );
  expect(withAction).toContain('scenario="reminder">');
  expect(withAction).not.toContain('arguments="dismiss"');
  expect(
    toastXml(
      parse({
        timeoutType: "never",
        reply: {
          buttonLabel: "Send",
        },
      }),
    ),
  ).not.toContain('arguments="dismiss"');
  expect(
    toastXml(
      parse({
        timeoutType: "never",
        sound: "Looping.Alarm",
        soundLoop: true,
      }),
    ),
  ).toContain('scenario="reminder" duration="long">');
  // expiresAfterSeconds is applied through ExpirationTime, not toast XML.
  expect(
    toastXml(
      parse({
        expiresAfterSeconds: 60,
      }),
    ),
  ).toBe(toastXml(input("reminder")));
});

test("show input validates timeoutType and bounds expiresAfterSeconds", () => {
  const accepts = (extra: Record<string, unknown>) =>
    notificationShowSchema.safeParse({
      id: "t",
      title: "T",
      ...extra,
    }).success;
  expect(
    accepts({
      expiresAfterSeconds: 1,
    }),
  ).toBe(true);
  expect(
    accepts({
      expiresAfterSeconds: MAX_EXPIRES_AFTER_SECONDS,
    }),
  ).toBe(true);
  for (const value of [
    MAX_EXPIRES_AFTER_SECONDS + 1,
    0,
    -1,
    1.5,
    Number.NaN,
    "60",
  ]) {
    expect(
      accepts({
        expiresAfterSeconds: value,
      }),
    ).toBe(false);
  }
  expect(
    accepts({
      timeoutType: "never",
      expiresAfterSeconds: 60,
      silent: true,
    }),
  ).toBe(true);
  expect(
    accepts({
      timeoutType: "sticky",
    }),
  ).toBe(false);
  // A suppressed popup never shows, so the timeout type has nothing to keep and is not an error.
  expect(
    accepts({
      timeoutType: "never",
      suppressPopup: true,
    }),
  ).toBe(true);
  expect(
    notificationShowSchema.parse({
      id: "t",
      title: "T",
    }),
  ).toMatchObject({
    timeoutType: "default",
    expiresAfterSeconds: null,
  });
});

test("replacement suppresses retired callbacks and retains the previous generation when Show fails", () => {
  const f = fixture();
  const first = {
    ...input(),
    data: "first",
  };
  f.controller.show(first);
  f.callbacks[0]?.({
    kind: "activated",
    arguments: "",
    reply: undefined,
  });
  f.failure("show", true);
  expect(() =>
    f.controller.show({
      ...first,
      data: "failed",
    }),
  ).toThrow("show failed");
  f.callbacks[0]?.({
    kind: "activated",
    arguments: "",
    reply: undefined,
  });
  f.failure("show", false);
  f.controller.show({
    ...first,
    data: "second",
  });
  f.callbacks[0]?.({
    kind: "activated",
    arguments: "",
    reply: undefined,
  });
  f.callbacks[1]?.({
    kind: "activated",
    arguments: "",
    reply: undefined,
  });
  f.callbacks[1]?.({
    kind: "dismissed",
    reason: "timedOut",
  });
  f.callbacks[1]?.({
    kind: "failed",
    hresult: 0x80004005,
  });
  expect(f.events).toEqual([
    {
      event: "notification.clicked",
      payload: {
        id: "example",
        group: "bunaway",
        data: "first",
      },
    },
    {
      event: "notification.clicked",
      payload: {
        id: "example",
        group: "bunaway",
        data: "first",
      },
    },
    {
      event: "notification.clicked",
      payload: {
        id: "example",
        group: "bunaway",
        data: "second",
      },
    },
    {
      event: "notification.dismissed",
      payload: {
        id: "example",
        group: "bunaway",
        reason: "timedOut",
      },
    },
    {
      event: "notification.failed",
      payload: {
        id: "example",
        group: "bunaway",
        hresult: 0x80004005,
      },
    },
  ]);
  expect(f.detached).toEqual([
    0,
  ]);
  f.controller.clear(first);
  f.callbacks[1]?.({
    kind: "activated",
    arguments: "",
    reply: undefined,
  });
  expect(f.events).toHaveLength(5);
  f.controller.clear({
    id: "old-process",
    group: "bunaway",
  });
  expect(f.cleared).toEqual([
    "bunaway/example",
    "bunaway/old-process",
  ]);
  f.controller.dispose();
  f.controller.dispose();
  expect(f.disposals).toBe(1);
});

test("bounded active ownership permits replacement and reclaims capacity after clear", () => {
  const f = fixture();
  for (let n = 0; n < MAX_ACTIVE_TOASTS; n++) {
    f.controller.show(input(String(n)));
  }
  expect(() => f.controller.show(input("overflow"))).toThrow(BunawayError);
  f.controller.show(input("0"));
  f.controller.clear({
    id: "0",
    group: "bunaway",
  });
  f.controller.show(input("overflow"));
  f.controller.dispose();
  expect(f.detached).toHaveLength(MAX_ACTIVE_TOASTS + 2);
});

test("clearAll takes only null, retires every owned toast, drops late callbacks and frees capacity", async () => {
  for (const payload of [
    {},
    {
      id: "first",
    },
    "all",
    false,
  ] as JsonValue[]) {
    await expect(
      parsers.validateCall({
        operation: "notification.clearAll",
        payload,
      }),
    ).rejects.toThrow();
  }
  await expect(
    parsers.validateOutput("notification.clearAll", {}),
  ).rejects.toThrow();
  const f = fixture();
  for (let n = 0; n < MAX_ACTIVE_TOASTS; n++) {
    f.controller.show(input(String(n)));
  }
  expect(() => f.controller.show(input("overflow"))).toThrow(BunawayError);
  expect(f.controller.clearAll()).toBeNull();
  expect(f.clearedAll).toBe(1);
  // Late callbacks from every retired toast are discarded and no dismissed event is synthesized.
  for (const callback of f.callbacks) {
    callback({
      kind: "dismissed",
      reason: "userCanceled",
    });
  }
  expect(f.events).toEqual([]);
  expect(f.detached).toHaveLength(MAX_ACTIVE_TOASTS);
  // The bound is released, so the full limit can be owned again.
  for (let n = 0; n < MAX_ACTIVE_TOASTS; n++) {
    f.controller.show(input(`n${n}`));
  }
  expect(() => f.controller.show(input("overflow"))).toThrow(BunawayError);
  f.controller.dispose();
});

test("clearGroup takes only a group, retires that group's toasts, keeps other groups live and retries after failure", async () => {
  for (const payload of [
    null,
    {},
    {
      id: "first",
    },
    {
      group: "bad group",
    },
    {
      group: "a",
      id: "first",
    },
    "a",
  ] as JsonValue[]) {
    await expect(
      parsers.validateCall({
        operation: "notification.clearGroup",
        payload,
      }),
    ).rejects.toThrow();
  }
  await expect(
    parsers.validateCall({
      operation: "notification.clearGroup",
      payload: {
        group: "chat-1",
      },
    }),
  ).resolves.toBeDefined();
  await expect(
    parsers.validateOutput("notification.clearGroup", {}),
  ).rejects.toThrow();
  const f = fixture();
  const inGroup = (id: string, group: string) =>
    notificationShowSchema.parse({
      id,
      group,
      title: "Hello",
    });
  f.controller.show(inGroup("a", "chat-1"));
  f.controller.show(inGroup("b", "chat-1"));
  f.controller.show(inGroup("a", "chat-2"));
  f.failure("clear", true);
  expect(() => f.controller.clearGroup("chat-1")).toThrow("clear failed");
  f.callbacks[0]?.({
    kind: "activated",
    arguments: "",
    reply: undefined,
  });
  expect(f.events).toHaveLength(1);
  expect(f.detached).toEqual([]);
  f.failure("clear", false);
  expect(f.controller.clearGroup("chat-1")).toBeNull();
  expect(f.clearedGroups).toEqual([
    "chat-1",
  ]);
  expect(f.detached).toEqual([
    0,
    1,
  ]);
  // Late callbacks of the cleared group are dropped without a dismissed event; the other group stays live.
  f.callbacks[1]?.({
    kind: "dismissed",
    reason: "userCanceled",
  });
  expect(f.events).toHaveLength(1);
  f.callbacks[2]?.({
    kind: "activated",
    arguments: "",
    reply: undefined,
  });
  expect(f.events).toHaveLength(2);
  // An unknown group succeeds and an empty group frees capacity for its entries only.
  expect(f.controller.clearGroup("none")).toBeNull();
  f.controller.dispose();
  expect(() => f.controller.clearGroup("chat-2")).toThrow(BunawayError);
});

test("list takes only null, validates the output and reads the driver without touching ownership", async () => {
  for (const payload of [
    {},
    {
      id: "first",
    },
    "all",
    false,
  ] as JsonValue[]) {
    await expect(
      parsers.validateCall({
        operation: "notification.list",
        payload,
      }),
    ).rejects.toThrow();
  }
  await expect(
    parsers.validateCall({
      operation: "notification.list",
      payload: null,
    }),
  ).resolves.toBeDefined();
  await expect(
    parsers.validateOutput("notification.list", {}),
  ).rejects.toThrow();
  await expect(
    parsers.validateOutput("notification.list", [
      {
        id: "bad id",
        group: "bunaway",
      },
    ]),
  ).rejects.toThrow();
  await expect(
    parsers.validateOutput("notification.list", [
      {
        id: "a",
        group: "bunaway",
      },
    ]),
  ).resolves.toBeDefined();
  const f = fixture();
  f.controller.show(input());
  f.setListed([
    {
      id: "left",
      group: "bunaway",
    },
  ]);
  expect(f.controller.list()).toEqual([
    {
      id: "left",
      group: "bunaway",
    },
  ]);
  // Listing neither retires the owned toast nor emits events.
  expect(f.detached).toEqual([]);
  expect(f.events).toEqual([]);
  f.controller.dispose();
  expect(() => f.controller.list()).toThrow(BunawayError);
});

test("clearAll failure keeps ownership so a retry succeeds and callbacks stay live until then", () => {
  const f = fixture();
  f.controller.show(input());
  f.failure("clear", true);
  expect(() => f.controller.clearAll()).toThrow("clear failed");
  f.callbacks[0]?.({
    kind: "activated",
    arguments: "",
    reply: undefined,
  });
  expect(f.events).toHaveLength(1);
  expect(f.detached).toEqual([]);
  f.failure("clear", false);
  expect(f.controller.clearAll()).toBeNull();
  expect(f.detached).toEqual([
    0,
  ]);
  f.callbacks[0]?.({
    kind: "activated",
    arguments: "",
    reply: undefined,
  });
  expect(f.events).toHaveLength(1);
  f.controller.dispose();
});

test("cleanup failures retain ownership for retry and stop callbacks before shutdown", () => {
  const f = fixture();
  f.controller.show(input());
  f.failure("detach", true);
  expect(f.controller.show(input())).toEqual({
    id: "example",
    group: "bunaway",
  });
  expect(() => f.controller.show(input("blocked"))).toThrow("detach failed");
  f.failure("detach", false);
  f.failure("clear", true);
  expect(() => f.controller.dispose()).toThrow("Toast cleanup failed");
  f.callbacks[1]?.({
    kind: "activated",
    arguments: "",
    reply: undefined,
  });
  expect(f.events).toEqual([]);
  expect(f.disposals).toBe(0);
  expect(() => f.controller.show(input())).toThrow(BunawayError);
  f.failure("clear", false);
  f.controller.dispose();
  expect(f.disposals).toBe(1);
});

test("WinRT ABI registers real delegates, copies callback values and retries failed revocation without use-after-free", () => {
  const child = Bun.spawnSync([
    process.execPath,
    "--no-env-file",
    fileURLToPath(
      new URL("../fixtures/notification-toast-ffi.ts", import.meta.url),
    ),
  ]);
  expect(child.exitCode, child.stderr.toString()).toBe(0);
});

test("show and schedule reject raw toast XML and other markup fields", () => {
  const xml = '<toast launch="app://other"><visual/></toast>';
  for (const field of [
    "toastXml",
    "xml",
    "launch",
    "activationType",
  ]) {
    expect(() =>
      notificationShowSchema.parse({
        id: "example",
        title: "Hello",
        [field]: xml,
      }),
    ).toThrow();
    expect(() =>
      notificationScheduleSchema.parse({
        id: "example",
        title: "Hello",
        deliverAt: 1,
        [field]: xml,
      }),
    ).toThrow();
  }
});
