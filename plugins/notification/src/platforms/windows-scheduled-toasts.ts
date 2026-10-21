import { type Pointer, ptr } from "bun:ffi";
import { BunawayError } from "@bunaway/protocol";
import {
  MAX_SCHEDULED_TOASTS,
  type NotificationResult,
  type ResolvedScheduledNotification,
  type ScheduledNotification,
  scheduledNotificationSchema,
} from "#notification/contract";
import { toastXml } from "#notification/platforms/toast-controller";
import {
  checkSchedule,
  checkToast,
  type createToastRuntime,
  fromWindowsTicks,
  loadXmlDocument,
  toWindowsTicks,
} from "#notification/platforms/toast-winrt";

// Windows.UI.Notifications ABI metadata.
const SCHEDULED_TOAST_CLASS =
  "Windows.UI.Notifications.ScheduledToastNotification";
const SCHEDULED_FACTORY_IID = "e7bed191-0bb9-4189-8394-31761b476fd7";
const SCHEDULED2_IID = "a66ea09c-31b4-43b0-b5dd-7a40e85363b1";
// IScheduledToastNotificationFactory: CreateScheduledToastNotification(6).
const CREATE_SCHEDULED_SLOT = 6;
// IToastNotifier follows Show(6), Hide(7), get_Setting(8): AddToSchedule(9), RemoveFromSchedule(10),
// GetScheduledToastNotifications(11).
const ADD_TO_SCHEDULE_SLOT = 9;
const REMOVE_FROM_SCHEDULE_SLOT = 10;
const GET_SCHEDULED_SLOT = 11;
// IScheduledToastNotification: get_DeliveryTime(7).
const GET_DELIVERY_TIME_SLOT = 7;
// IScheduledToastNotification2: put_Tag(6), get_Tag(7), put_Group(8), get_Group(9), put_SuppressPopup(10).
const PUT_TAG_SLOT = 6;
const GET_TAG_SLOT = 7;
const PUT_GROUP_SLOT = 8;
const GET_GROUP_SLOT = 9;
const PUT_SUPPRESS_POPUP_SLOT = 10;
// IVectorView<ScheduledToastNotification>: GetAt(6), get_Size(7).
const VECTOR_GET_AT_SLOT = 6;
const VECTOR_SIZE_SLOT = 7;

type Runtime = ReturnType<typeof createToastRuntime>;
/** One entry of the app's schedule. `entry` is undefined for items whose tag or group is outside the identity contract. */
type ScheduledItem = {
  pointer: Pointer;
  entry: ScheduledNotification | undefined;
};

/**
 * Scheduling for one app notifier. A scheduled toast is owned by Windows after `AddToSchedule` and is shown
 * even when this process has exited, so nothing here keeps native references beyond one call and no event
 * delegates are attached. Every call runs on the notifier's STA.
 */
export function createScheduledToasts(runtime: Runtime, notifier: Pointer) {
  const identityMatches = (
    item: ScheduledItem,
    identity: NotificationResult,
  ): boolean =>
    item.entry?.id === identity.id && item.entry.group === identity.group;

  function readText(properties: Pointer, slot: number, stage: string): string {
    const out = new BigUint64Array(1);
    checkToast(
      runtime.method(
        properties,
        slot,
        [
          "ptr",
        ],
        ptr(out),
      ),
      stage,
    );
    return runtime.takeString(Number(out[0]) as Pointer);
  }

  function readItem(pointer: Pointer): ScheduledItem {
    const time = new BigInt64Array(1);
    checkToast(
      runtime.method(
        pointer,
        GET_DELIVERY_TIME_SLOT,
        [
          "ptr",
        ],
        ptr(time),
      ),
      "ScheduledToast.DeliveryTime",
    );
    const properties = runtime.query(pointer, SCHEDULED2_IID);
    try {
      // Items scheduled by other code under the same app ID may lack a tag or use characters outside our contract.
      const parsed = scheduledNotificationSchema.safeParse({
        id: readText(properties, GET_TAG_SLOT, "ScheduledToast.Tag"),
        group: readText(properties, GET_GROUP_SLOT, "ScheduledToast.Group"),
        deliverAt: fromWindowsTicks(time[0] ?? 0n),
      });
      return {
        pointer,
        entry: parsed.success ? parsed.data : undefined,
      };
    } finally {
      runtime.release(properties);
    }
  }

  /** Read a snapshot of the schedule and release every item reference when `use` returns or throws. */
  function withSchedule<T>(use: (items: ScheduledItem[]) => T): T {
    const vector = runtime.object(
      (out) =>
        runtime.method(
          notifier,
          GET_SCHEDULED_SLOT,
          [
            "ptr",
          ],
          out,
        ),
      "ToastNotifier.GetScheduledToastNotifications",
    );
    const items: ScheduledItem[] = [];
    const held: Pointer[] = [];
    try {
      const size = new Uint32Array(1);
      checkToast(
        runtime.method(
          vector,
          VECTOR_SIZE_SLOT,
          [
            "ptr",
          ],
          ptr(size),
        ),
        "ScheduledToasts.Size",
      );
      for (let index = 0; index < (size[0] ?? 0); index++) {
        const pointer = runtime.object(
          (out) =>
            runtime.method(
              vector,
              VECTOR_GET_AT_SLOT,
              [
                "u32",
                "ptr",
              ],
              index,
              out,
            ),
          "ScheduledToasts.GetAt",
        );
        held.push(pointer);
        items.push(readItem(pointer));
      }
      return use(items);
    } finally {
      for (const pointer of held) {
        runtime.release(pointer);
      }
      runtime.release(vector);
    }
  }

  function removeItem(item: ScheduledItem): void {
    checkToast(
      runtime.method(
        notifier,
        REMOVE_FROM_SCHEDULE_SLOT,
        [
          "ptr",
        ],
        item.pointer,
      ),
      "ToastNotifier.RemoveFromSchedule",
    );
  }

  /** Build the native scheduled toast with its identity, popup flag and delivery instant. */
  function createScheduledToast(input: ResolvedScheduledNotification): Pointer {
    const document = loadXmlDocument(runtime, toastXml(input));
    try {
      const factory = runtime.factory(
        SCHEDULED_TOAST_CLASS,
        SCHEDULED_FACTORY_IID,
      );
      try {
        const out = new BigUint64Array(1);
        checkSchedule(
          runtime.method(
            factory,
            CREATE_SCHEDULED_SLOT,
            [
              "ptr",
              "i64",
              "ptr",
            ],
            document,
            toWindowsTicks(input.deliverAt),
            ptr(out),
          ),
          "CreateScheduledToastNotification",
        );
        if (!out[0]) {
          throw new BunawayError({
            code: "INTERNAL",
            message: "Missing scheduled toast COM object.",
          });
        }
        return Number(out[0]) as Pointer;
      } finally {
        runtime.release(factory);
      }
    } finally {
      runtime.release(document);
    }
  }

  function describe(toast: Pointer, input: ResolvedScheduledNotification) {
    const properties = runtime.query(toast, SCHEDULED2_IID);
    try {
      runtime.string(input.id, (id) =>
        checkToast(
          runtime.method(
            properties,
            PUT_TAG_SLOT,
            [
              "ptr",
            ],
            id,
          ),
          "ScheduledToast.Tag",
        ),
      );
      runtime.string(input.group, (group) =>
        checkToast(
          runtime.method(
            properties,
            PUT_GROUP_SLOT,
            [
              "ptr",
            ],
            group,
          ),
          "ScheduledToast.Group",
        ),
      );
      checkToast(
        runtime.method(
          properties,
          PUT_SUPPRESS_POPUP_SLOT,
          [
            "u8",
          ],
          input.suppressPopup ? 1 : 0,
        ),
        "ScheduledToast.SuppressPopup",
      );
    } finally {
      runtime.release(properties);
    }
  }

  return {
    /**
     * Schedule a toast. A toast already scheduled under the same id and group is replaced: the new one is
     * added first, so a rejected request leaves the previous schedule in place.
     */
    schedule(input: ResolvedScheduledNotification): void {
      withSchedule((items) => {
        const previous = items.filter((item) => identityMatches(item, input));
        // A replacement adds before it removes, so a full schedule is rejected for replacements too.
        if (items.length >= MAX_SCHEDULED_TOASTS) {
          throw new BunawayError({
            code: "BUSY",
            message:
              "Cancel a scheduled notification before scheduling another.",
          });
        }
        const toast = createScheduledToast(input);
        try {
          describe(toast, input);
          checkSchedule(
            runtime.method(
              notifier,
              ADD_TO_SCHEDULE_SLOT,
              [
                "ptr",
              ],
              toast,
            ),
            "ToastNotifier.AddToSchedule",
          );
        } finally {
          runtime.release(toast);
        }
        for (const item of previous) {
          removeItem(item);
        }
      });
    },
    /** Scheduled toasts of the host app ID that have not been delivered, including earlier processes. */
    listScheduled(): ScheduledNotification[] {
      return withSchedule((items) =>
        items.flatMap((item) =>
          item.entry
            ? [
                item.entry,
              ]
            : [],
        ),
      );
    },
    /** Remove every scheduled toast with this id and group. A missing schedule is not an error. */
    cancelScheduled(identity: NotificationResult): void {
      withSchedule((items) => {
        for (const item of items) {
          if (identityMatches(item, identity)) {
            removeItem(item);
          }
        }
      });
    },
  };
}
