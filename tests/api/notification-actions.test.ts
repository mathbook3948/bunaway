import { expect, test } from "bun:test";
import type { JsonValue } from "@bunaway/protocol";
import { z } from "zod";
import {
  MAX_REPLY_LENGTH,
  MAX_TOAST_ACTIONS,
  notificationEvents,
  notificationShowSchema,
  type ToastEvent,
} from "#plugins/notification/src/contract";
import {
  createToastController,
  type ToastDriver,
  toastXml,
} from "#plugins/notification/src/platforms/toast-controller";

const show = (extra: Record<string, unknown>) =>
  notificationShowSchema.parse({
    id: "example",
    title: "Hello",
    data: "payload",
    ...extra,
  });
const action = (id: string, label = id) => ({
  id,
  label,
});

function controllerFor(extra: Record<string, unknown>) {
  const callbacks: ((event: ToastEvent) => void)[] = [];
  const events: {
    event: string;
    payload: JsonValue;
  }[] = [];
  const driver: ToastDriver = {
    show: (_input, receive) => {
      callbacks.push(receive);
      return {
        detach() {},
      };
    },
    clear() {},
    clearGroup() {},
    clearAll() {},
    list: () => [],
    dispose() {},
  };
  const controller = createToastController(driver, (event, payload) =>
    events.push({
      event,
      payload,
    }),
  );
  controller.show(show(extra));
  const activate = async (args: string, reply?: string) => {
    callbacks[0]?.({
      kind: "activated",
      arguments: args,
      reply,
    });
    await Promise.resolve();
  };
  return {
    events,
    activate,
  };
}

test("action and reply inputs are validated and default to none", () => {
  const plain = show({});
  expect(plain.actions).toEqual([]);
  expect(plain.reply).toBeNull();
  expect(
    show({
      actions: [
        action("ok"),
      ],
      reply: {
        buttonLabel: "Send",
      },
    }).reply,
  ).toEqual({
    placeholder: "",
    buttonLabel: "Send",
  });
  const rejected: Record<string, unknown>[] = [
    {
      actions: [
        action("a"),
        action("a", "again"),
      ],
    },
    {
      actions: Array.from(
        {
          length: MAX_TOAST_ACTIONS + 1,
        },
        (_, index) => action(`a${index}`),
      ),
    },
    {
      // The reply submit button counts against the button limit.
      actions: Array.from(
        {
          length: MAX_TOAST_ACTIONS,
        },
        (_, index) => action(`a${index}`),
      ),
      reply: {
        buttonLabel: "Send",
      },
    },
    {
      actions: [
        action("has space"),
      ],
    },
    {
      actions: [
        action("a:b"),
      ],
    },
    {
      actions: [
        action("ok", ""),
      ],
    },
    {
      actions: [
        action("ok", "bad\0"),
      ],
    },
    {
      actions: [
        {
          id: "ok",
          label: "OK",
          extra: 1,
        },
      ],
    },
    {
      reply: {},
    },
    {
      reply: {
        buttonLabel: "",
      },
    },
    {
      reply: {
        buttonLabel: "Send",
        placeholder: "x".repeat(129),
      },
    },
  ];
  for (const extra of rejected) {
    expect(
      notificationShowSchema.safeParse({
        id: "example",
        title: "Hello",
        ...extra,
      }).success,
      JSON.stringify(extra),
    ).toBe(false);
  }
  expect(
    show({
      actions: Array.from(
        {
          length: MAX_TOAST_ACTIONS,
        },
        (_, index) => action(`a${index}`),
      ),
    }).actions,
  ).toHaveLength(MAX_TOAST_ACTIONS);
});

test("toast XML declares the buttons and reply box with escaped attributes and no caller data", () => {
  expect(toastXml(show({}))).not.toContain("<actions>");
  const xml = toastXml(
    show({
      actions: [
        action("yes", '"Yes" & <more>'),
        action("no"),
      ],
      reply: {
        placeholder: "Type '<here>'",
        buttonLabel: "Send",
      },
      silent: true,
    }),
  );
  expect(xml).toBe(
    '<toast><visual><binding template="ToastGeneric"><text>Hello</text><text></text></binding></visual>' +
      '<actions><input id="reply" type="text" placeHolderContent="Type &apos;&lt;here&gt;&apos;"/>' +
      '<action content="Send" arguments="reply" activationType="foreground" hint-inputId="reply"/>' +
      '<action content="&quot;Yes&quot; &amp; &lt;more&gt;" arguments="action:yes" activationType="foreground"/>' +
      '<action content="no" arguments="action:no" activationType="foreground"/></actions>' +
      '<audio silent="true"/></toast>',
  );
  expect(xml).not.toContain("payload");
  expect(xml).not.toContain("launch");
});

test("a body click keeps publishing notification.clicked", async () => {
  const f = controllerFor({
    actions: [
      action("ok"),
    ],
  });
  await f.activate("");
  expect(f.events).toEqual([
    {
      event: "notification.clicked",
      payload: {
        id: "example",
        group: "bunaway",
        data: "payload",
      },
    },
  ]);
});

test("a declared button publishes actionInvoked with the typed reply when the toast has a reply box", async () => {
  const f = controllerFor({
    actions: [
      action("ok"),
    ],
    reply: {
      buttonLabel: "Send",
    },
  });
  await f.activate("action:ok", "typed text");
  await f.activate("reply", "line");
  // No reply text from the driver is a contract violation, not an empty reply.
  await f.activate("reply");
  const base = {
    id: "example",
    group: "bunaway",
    data: "payload",
  };
  expect(f.events).toEqual([
    {
      event: "notification.actionInvoked",
      payload: {
        ...base,
        actionId: "ok",
        reply: "typed text",
      },
    },
    {
      event: "notification.actionInvoked",
      payload: {
        ...base,
        actionId: null,
        reply: "line",
      },
    },
  ]);
});

test("a button on a toast without a reply box reports a null reply", async () => {
  const f = controllerFor({
    actions: [
      action("ok"),
    ],
  });
  await f.activate("action:ok", "ignored");
  expect(f.events.map((entry) => entry.payload)).toEqual([
    {
      id: "example",
      group: "bunaway",
      actionId: "ok",
      reply: null,
      data: "payload",
    },
  ]);
});

test("undeclared arguments and oversized replies publish nothing", async () => {
  const f = controllerFor({
    actions: [
      action("ok"),
    ],
    reply: {
      buttonLabel: "Send",
    },
  });
  await f.activate("action:other");
  await f.activate("action:");
  await f.activate("something");
  await f.activate("action:ok", "x".repeat(MAX_REPLY_LENGTH + 1));
  expect(f.events).toEqual([]);
  await f.activate("action:ok", "x".repeat(MAX_REPLY_LENGTH));
  expect(f.events).toHaveLength(1);
  // A reply argument is only valid when this toast declared the reply box.
  const noReply = controllerFor({
    actions: [
      action("ok"),
    ],
  });
  await noReply.activate("reply", "text");
  expect(noReply.events).toEqual([]);
});

test("published actionInvoked payloads satisfy the event schema, including its bounds", async () => {
  const schema = z.fromJSONSchema(
    JSON.parse(
      JSON.stringify(notificationEvents["notification.actionInvoked"]),
    ),
  );
  const f = controllerFor({
    actions: [
      action("ok"),
    ],
    reply: {
      buttonLabel: "Send",
    },
  });
  await f.activate("action:ok", "x".repeat(MAX_REPLY_LENGTH));
  await f.activate("reply", "");
  const noReply = controllerFor({
    actions: [
      action("ok"),
    ],
  });
  await noReply.activate("action:ok");
  const payloads = [
    ...f.events,
    ...noReply.events,
  ].map((entry) => entry.payload);
  expect(payloads).toHaveLength(3);
  for (const payload of payloads) {
    expect(schema.safeParse(payload).success).toBe(true);
  }
  expect(
    schema.safeParse({
      ...(payloads[0] as object),
      reply: "x".repeat(MAX_REPLY_LENGTH + 1),
    }).success,
  ).toBe(false);
  expect(
    schema.safeParse({
      ...(payloads[0] as object),
      actionId: "bad id",
    }).success,
  ).toBe(false);
  expect(
    schema.safeParse({
      ...(payloads[0] as object),
      extra: 1,
    }).success,
  ).toBe(false);
});
