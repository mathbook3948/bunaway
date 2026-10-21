import { expect, test } from "bun:test";
import type { JsonValue } from "@bunaway/protocol";
import {
  MAX_PENDING_ACTIVATIONS,
  MAX_REPLY_LENGTH,
  notificationEvents,
  notificationShowSchema,
  type ToastEvent,
  takenActivationListSchema,
} from "#plugins/notification/src/contract";
import {
  activationArguments,
  MAX_ACTIVATION_ARGUMENT_LENGTH,
  parseActivationArguments,
} from "#plugins/notification/src/platforms/toast-activation-args";
import { createActivationInbox } from "#plugins/notification/src/platforms/toast-activation-inbox";
import {
  createToastController,
  type ToastDriver,
} from "#plugins/notification/src/platforms/toast-controller";

const APP_ID = "com.example.app";

type Published = {
  event: string;
  payload: JsonValue;
};

/** An inbox wired to a controller with one live toast, the way the Windows adapter wires them. */
function setup(extra: Record<string, unknown> | null = null) {
  const published: Published[] = [];
  const objectRoutes: ((event: ToastEvent) => void)[] = [];
  const driver: ToastDriver = {
    show: (_input, receive) => {
      objectRoutes.push(receive);
      return {
        detach() {},
      };
    },
    clear() {},
    clearGroup() {},
    schedule() {},
    listScheduled: () => [],
    cancelScheduled() {},
    clearAll() {},
    list: () => [],
    dispose() {},
  };
  const publish = (event: string, payload: JsonValue) =>
    published.push({
      event,
      payload,
    });
  const controller = createToastController(driver, publish);
  if (extra) {
    controller.show(
      notificationShowSchema.parse({
        id: "live",
        title: "Hello",
        data: "payload",
        ...extra,
      }),
    );
  }
  const inbox = createActivationInbox({
    appUserModelId: APP_ID,
    publish,
    live: () => controller,
  });
  const click = (
    args: string,
    reply: string | null = null,
    appUserModelId = APP_ID,
  ) =>
    inbox.receive({
      appUserModelId,
      arguments: args,
      reply,
    });
  const clickToast = async (args: string, reply?: string) => {
    objectRoutes[0]?.({
      kind: "activated",
      arguments: args,
      reply,
    });
    await Promise.resolve();
  };
  return {
    published,
    inbox,
    click,
    clickToast,
  };
}

const arg = (id: string, target: Parameters<typeof activationArguments>[1]) =>
  activationArguments(
    {
      id,
      group: "bunaway",
    },
    target,
  );

test("activation arguments round trip and name the identity", () => {
  expect(
    arg("order", {
      kind: "body",
    }),
  ).toBe("bunaway1;bunaway;order;");
  expect(
    arg("order", {
      kind: "reply",
    }),
  ).toBe("bunaway1;bunaway;order;reply");
  expect(
    arg("order", {
      kind: "action",
      actionId: "open",
    }),
  ).toBe("bunaway1;bunaway;order;action:open");
  for (const target of [
    {
      kind: "body",
    },
    {
      kind: "reply",
    },
    {
      kind: "action",
      actionId: "a.b-c_1",
    },
  ] as const) {
    expect(parseActivationArguments(arg("order", target))).toEqual({
      id: "order",
      group: "bunaway",
      target,
    });
  }
});

test("activation arguments outside the exact format are rejected", () => {
  for (const text of [
    "",
    "reply",
    "action:open",
    "bunaway2;bunaway;order;",
    "bunaway1;bunaway;order",
    "bunaway1;bunaway;order;other",
    "bunaway1;bunaway;order;action:",
    "bunaway1;bunaway;order;action:a;b",
    "bunaway1;bunaway;order;action:open\n",
    "bunaway1;bunaway;order;\n",
    "bunaway1;;order;",
    "bunaway1;bunaway;a b;",
    "bunaway1;bunaway;order;;",
    "bunaway1;bunaway;order;action:open;extra",
    `bunaway1;bunaway;${"x".repeat(17)};`,
    `bunaway1;bunaway;order;${"x".repeat(MAX_ACTIVATION_ARGUMENT_LENGTH)}`,
  ]) {
    expect(parseActivationArguments(text)).toBeUndefined();
  }
  // The longest accepted form is well inside the length bound.
  const longest = arg("i".repeat(16), {
    kind: "action",
    actionId: "a".repeat(16),
  });
  expect(longest.length).toBeLessThanOrEqual(MAX_ACTIVATION_ARGUMENT_LENGTH);
  expect(parseActivationArguments(longest)).toBeDefined();
});

test("a click with no toast of this run is held until the first take", () => {
  const f = setup();
  f.click(
    arg("old", {
      kind: "body",
    }),
  );
  f.click(
    arg("old", {
      kind: "action",
      actionId: "open",
    }),
    "typed",
  );
  f.click(
    arg("old", {
      kind: "reply",
    }),
  );
  expect(f.published).toEqual([]);
  const taken = f.inbox.take();
  expect(taken).toEqual([
    {
      kind: "clicked",
      id: "old",
      group: "bunaway",
      actionId: null,
      reply: null,
      data: null,
    },
    {
      kind: "actionInvoked",
      id: "old",
      group: "bunaway",
      actionId: "open",
      reply: "typed",
      data: null,
    },
    {
      kind: "actionInvoked",
      id: "old",
      group: "bunaway",
      actionId: null,
      reply: "",
      data: null,
    },
  ]);
  expect(takenActivationListSchema.safeParse(taken).success).toBe(true);
  expect(f.inbox.take()).toEqual([]);
});

test("clicks after the first take are published as events with null data", () => {
  const f = setup();
  expect(f.inbox.take()).toEqual([]);
  f.click(
    arg("old", {
      kind: "body",
    }),
  );
  f.click(
    arg("old", {
      kind: "action",
      actionId: "open",
    }),
    "typed",
  );
  expect(f.published).toEqual([
    {
      event: "notification.clicked",
      payload: {
        id: "old",
        group: "bunaway",
        data: null,
      },
    },
    {
      event: "notification.actionInvoked",
      payload: {
        id: "old",
        group: "bunaway",
        actionId: "open",
        reply: "typed",
        data: null,
      },
    },
  ]);
  // The payload has exactly the fields the event contract declares.
  expect(Object.keys(f.published[1]?.payload ?? {}).sort()).toEqual(
    [
      ...notificationEvents["notification.actionInvoked"].required,
    ].sort(),
  );
});

test("the held clicks are bounded and drop the oldest first", () => {
  const f = setup();
  for (let index = 0; index < MAX_PENDING_ACTIVATIONS + 3; index++) {
    f.click(
      arg(`n${index}`, {
        kind: "body",
      }),
    );
  }
  const ids = f.inbox.take().map((activation) => activation.id);
  expect(ids).toHaveLength(MAX_PENDING_ACTIVATIONS);
  expect(ids[0]).toBe("n3");
  expect(ids.at(-1)).toBe(`n${MAX_PENDING_ACTIVATIONS + 2}`);
});

test("calls for another app or with foreign arguments are dropped", () => {
  const f = setup();
  const valid = arg("old", {
    kind: "body",
  });
  f.click(valid, null, "another.app");
  f.click("");
  f.click("action:open");
  f.click(`${valid}extra`);
  f.click("x".repeat(MAX_ACTIVATION_ARGUMENT_LENGTH + 1));
  expect(f.inbox.take()).toEqual([]);
  // Identifiers are case-insensitive, so the same app in another spelling is accepted.
  const other = setup();
  other.click(valid, null, APP_ID.toUpperCase());
  expect(other.inbox.take()).toHaveLength(1);
});

test("a click on a toast of this run keeps its data and checks the declared buttons", () => {
  const f = setup({
    actions: [
      {
        id: "ok",
        label: "OK",
      },
    ],
    reply: {
      buttonLabel: "Send",
    },
  });
  f.click(
    arg("live", {
      kind: "action",
      actionId: "ok",
    }),
    "typed",
  );
  // Not declared by this toast: consumed without an event and without a cold entry.
  f.click(
    arg("live", {
      kind: "action",
      actionId: "other",
    }),
  );
  f.click(
    arg("live", {
      kind: "reply",
    }),
    "x".repeat(MAX_REPLY_LENGTH + 1),
  );
  expect(f.published).toEqual([
    {
      event: "notification.actionInvoked",
      payload: {
        id: "live",
        group: "bunaway",
        actionId: "ok",
        reply: "typed",
        data: "payload",
      },
    },
  ]);
  expect(f.inbox.take()).toEqual([]);
});

test("a reply to a live toast without a reply box reports no text and a reply button is refused", () => {
  const f = setup({
    actions: [
      {
        id: "ok",
        label: "OK",
      },
    ],
  });
  f.click(
    arg("live", {
      kind: "action",
      actionId: "ok",
    }),
    "ignored",
  );
  f.click(
    arg("live", {
      kind: "reply",
    }),
    "text",
  );
  expect(f.published).toEqual([
    {
      event: "notification.actionInvoked",
      payload: {
        id: "live",
        group: "bunaway",
        actionId: "ok",
        reply: null,
        data: "payload",
      },
    },
  ]);
});

test("one click publishes once whichever route reports it first", async () => {
  const toastFirst = setup({
    actions: [
      {
        id: "ok",
        label: "OK",
      },
    ],
  });
  const body = arg("live", {
    kind: "body",
  });
  await toastFirst.clickToast(body);
  toastFirst.click(body);
  expect(toastFirst.published).toHaveLength(1);
  // The duplicate was consumed, so a later click that only the activator reports is not lost.
  toastFirst.click(body);
  expect(toastFirst.published).toHaveLength(2);

  const activatorFirst = setup({
    actions: [
      {
        id: "ok",
        label: "OK",
      },
    ],
  });
  activatorFirst.click(body);
  await activatorFirst.clickToast(body);
  expect(activatorFirst.published).toHaveLength(1);
  expect(activatorFirst.published[0]?.event).toBe("notification.clicked");

  // Repeated clicks reported by the toast object itself are not collapsed.
  const repeated = setup({
    actions: [
      {
        id: "ok",
        label: "OK",
      },
    ],
  });
  await repeated.clickToast(body);
  await repeated.clickToast(body);
  expect(repeated.published).toHaveLength(2);
});

test("the toast object route ignores arguments of another identity", async () => {
  const f = setup({
    actions: [
      {
        id: "ok",
        label: "OK",
      },
    ],
  });
  await f.clickToast(
    arg("someone", {
      kind: "body",
    }),
  );
  await f.clickToast("reply");
  await f.clickToast("action:ok");
  expect(f.published).toEqual([]);
});
