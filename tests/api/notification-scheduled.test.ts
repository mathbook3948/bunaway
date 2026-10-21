import { expect, setDefaultTimeout, test } from "bun:test";
import { fileURLToPath } from "node:url";
import notification from "@bunaway/plugin-notification";
import { BunawayError, NativeRegistry } from "@bunaway/protocol";
import {
  MAX_DELIVER_AT_MS,
  type NotificationResult,
  notificationScheduleSchema,
  type ResolvedScheduledNotification,
  type ScheduledNotification,
  validateNotificationInput,
} from "#plugins/notification/src/contract";
import { notificationOperations } from "#plugins/notification/src/operations";
import {
  createToastController,
  type ToastDriver,
  toastXml,
} from "#plugins/notification/src/platforms/toast-controller";
import { deadline } from "../fixtures/deadlines.ts";
import { pluginParsers } from "../fixtures/plugin-parsers.ts";

setDefaultTimeout(deadline("build"));

const parsers = pluginParsers("notification", notificationOperations);
const registry = new NativeRegistry([
  notification._definition,
]);
/** A delivery time far enough ahead that the controller accepts it. */
const LEAD_MS = 60_000;
const future = () => Date.now() + LEAD_MS;
const request = (id = "example", deliverAt: unknown = future()) => ({
  id,
  title: "Hello",
  deliverAt,
});

function fixture() {
  const scheduled: ResolvedScheduledNotification[] = [];
  const cancelled: string[] = [];
  let listed: ScheduledNotification[] = [];
  let disposals = 0;
  const driver: ToastDriver = {
    show: () => ({
      detach() {},
    }),
    clear() {},
    clearGroup() {},
    clearAll() {},
    list: () => [],
    schedule(input) {
      scheduled.push(input);
    },
    listScheduled: () => listed,
    cancelScheduled(identity: NotificationResult) {
      cancelled.push(`${identity.group}/${identity.id}`);
    },
    dispose() {
      disposals++;
    },
  };
  const controller = createToastController(driver, () => {});
  return {
    controller,
    scheduled,
    cancelled,
    setListed(items: ScheduledNotification[]) {
      listed = items;
    },
    get disposals() {
      return disposals;
    },
  };
}

test("schedule shares the show content rules and requires a bounded integer deliverAt", async () => {
  expect(notificationScheduleSchema.parse(request("first"))).toMatchObject({
    id: "first",
    group: "bunaway",
    body: "",
    silent: false,
    timeoutType: "default",
  });
  await expect(
    parsers.validateCall({
      operation: "notification.schedule",
      payload: request("valid", MAX_DELIVER_AT_MS) as never,
    }),
  ).resolves.toBeDefined();
  const bad: Record<string, unknown>[] = [
    {
      id: "no-time",
      title: "x",
    },
    request("fraction", 1.5),
    request("zero", 0),
    request("far", MAX_DELIVER_AT_MS + 1),
    request("text", "tomorrow"),
    {
      ...request("expires"),
      expiresAfterSeconds: 60,
    },
    {
      ...request("dup"),
      actions: [
        {
          id: "a",
          label: "A",
        },
        {
          id: "a",
          label: "B",
        },
      ],
    },
    {
      ...request("silent"),
      silent: true,
      sound: "Mail",
    },
    {
      ...request("hero"),
      imagePlacement: "hero",
    },
    {
      ...request("path"),
      icon: "\\\\server\\share\\a.png",
    },
    request("../bad"),
  ];
  for (const payload of bad) {
    await expect(
      parsers.validateCall({
        operation: "notification.schedule",
        payload: payload as never,
      }),
    ).rejects.toThrow();
    expect(() =>
      validateNotificationInput("notification.schedule", payload as never),
    ).toThrow();
  }
  // show keeps rejecting deliverAt, so a scheduled request cannot be shown immediately by mistake.
  expect(() =>
    validateNotificationInput("notification.show", request("show") as never),
  ).toThrow();
});

test("scheduled operations take their own inputs, outputs and grants", async () => {
  await expect(
    parsers.validateCall({
      operation: "notification.listScheduled",
      payload: null,
    }),
  ).resolves.toMatchObject({
    payload: null,
  });
  expect(() =>
    validateNotificationInput("notification.listScheduled", {}),
  ).toThrow();
  await expect(
    parsers.validateCall({
      operation: "notification.cancelScheduled",
      payload: {
        id: "first",
      },
    }),
  ).resolves.toMatchObject({
    payload: {
      id: "first",
      group: "bunaway",
    },
  });
  await expect(
    parsers.validateCall({
      operation: "notification.cancelScheduled",
      payload: {
        id: "first",
        all: true,
      },
    }),
  ).rejects.toThrow();
  await expect(
    parsers.validateOutput("notification.schedule", {
      id: "first",
      group: "bunaway",
    }),
  ).resolves.toBeDefined();
  await expect(
    parsers.validateOutput("notification.listScheduled", [
      {
        id: "first",
        group: "bunaway",
        deliverAt: 1_800_000_000_000,
      },
    ]),
  ).resolves.toBeDefined();
  for (const output of [
    [
      {
        id: "first",
        group: "bunaway",
      },
    ],
    [
      {
        id: "first",
        group: "bunaway",
        deliverAt: 1.5,
      },
    ],
  ]) {
    await expect(
      parsers.validateOutput("notification.listScheduled", output),
    ).rejects.toThrow();
  }
  const payloads = {
    "notification.schedule": request("first"),
    "notification.listScheduled": null,
    "notification.cancelScheduled": {
      id: "first",
      group: "bunaway",
    },
  } as const;
  for (const [operation, payload] of Object.entries(payloads)) {
    for (const granted of [
      ...Object.keys(payloads),
      "notification.show",
    ]) {
      expect(
        registry.allowed(
          {
            permissions: [
              granted,
            ],
          },
          {
            operation,
            payload: payload as never,
          },
        ),
      ).toBe(granted === operation);
    }
  }
});

test("schedule rejects a delivery time that is not in the future and hands the rest to the driver", () => {
  const f = fixture();
  const resolved = (deliverAt: number) =>
    notificationScheduleSchema.parse(request("later", deliverAt));
  for (const deliverAt of [
    1,
    Date.now() - 1,
  ]) {
    let code: string | undefined;
    try {
      f.controller.schedule(resolved(deliverAt));
    } catch (error) {
      code = error instanceof BunawayError ? error.code : undefined;
    }
    expect(code).toBe("INVALID_ARGUMENT");
  }
  expect(f.scheduled).toEqual([]);
  const input = resolved(future());
  expect(f.controller.schedule(input)).toEqual({
    id: "later",
    group: "bunaway",
  });
  expect(f.scheduled).toEqual([
    input,
  ]);
});

test("scheduled toasts are owned by the OS: listing and cancelling pass through and dispose leaves them", () => {
  const f = fixture();
  f.controller.schedule(notificationScheduleSchema.parse(request("kept")));
  const items = [
    {
      id: "kept",
      group: "bunaway",
      deliverAt: future(),
    },
  ];
  f.setListed(items);
  expect(f.controller.listScheduled()).toEqual(items);
  expect(
    f.controller.cancelScheduled({
      id: "kept",
      group: "bunaway",
    }),
  ).toBeNull();
  expect(f.cancelled).toEqual([
    "bunaway/kept",
  ]);
  f.controller.dispose();
  // Dispose releases the driver only; it does not cancel what the OS already holds.
  expect(f.cancelled).toEqual([
    "bunaway/kept",
  ]);
  expect(f.disposals).toBe(1);
  for (const call of [
    () => f.controller.schedule(notificationScheduleSchema.parse(request())),
    () => f.controller.listScheduled(),
    () =>
      f.controller.cancelScheduled({
        id: "kept",
        group: "bunaway",
      }),
  ]) {
    expect(call).toThrow(BunawayError);
  }
});

test("scheduled toasts render the same XML as shown ones", () => {
  const xml = toastXml(
    notificationScheduleSchema.parse({
      ...request("xml"),
      title: "<Due>",
      timeoutType: "never",
    }),
  );
  expect(xml).toContain("&lt;Due&gt;");
  expect(xml).toContain('scenario="reminder"');
});

test("WinRT ABI schedules, lists, replaces and cancels with balanced COM ownership", () => {
  const child = Bun.spawnSync([
    process.execPath,
    "--no-env-file",
    fileURLToPath(
      new URL("../fixtures/notification-scheduled-ffi.ts", import.meta.url),
    ),
  ]);
  expect(child.exitCode, child.stderr.toString()).toBe(0);
});
