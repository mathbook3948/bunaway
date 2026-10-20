import { dlopen, type Pointer, ptr } from "bun:ffi";
import { KERNEL32, pick } from "@bunaway/plugin/win32";
import { BunawayError } from "@bunaway/protocol";
import {
  type NotificationResult,
  notificationResultSchema,
  type ResolvedNotification,
  type ToastEvent,
} from "#notification/contract";
import { readActivation } from "#notification/platforms/toast-activation";
import {
  REPLY_INPUT_ID,
  type ToastDriver,
  type ToastHandle,
  toastXml,
} from "#notification/platforms/toast-controller";
import {
  checkToast,
  createToastDelegate,
  createToastRuntime,
} from "#notification/platforms/toast-winrt";

// Windows SDK Windows.UI.Notifications and Windows.Data.Xml.Dom ABI metadata.
const MANAGER = "Windows.UI.Notifications.ToastNotificationManager";
const MANAGER_IID = "50ac103f-d235-4598-bbef-98fe4d1a3ad4";
const HISTORY_MANAGER_IID = "7ab93c52-0e48-4750-ba9d-1a4113981847";
const TOAST_FACTORY_IID = "04124b20-82c6-4229-b109-fd9ed4662b53";
const HISTORY2_IID = "3bc3d253-2f31-4092-9129-8ad5abf067da";
const TOAST2_IID = "9dfb9fd1-143a-490e-90bf-b9fba7132de7";
const XML_IO_IID = "6cd0e74e-ee65-4489-9ebf-ca43e87ba637";
const EVENTS = [
  {
    kind: "clicked",
    add: 11,
    remove: 12,
    iid: "ab54de2d-97d9-5528-b6ad-105afe156530",
  },
  {
    kind: "dismissed",
    add: 9,
    remove: 10,
    iid: "61c2402f-0ed0-5a18-ab69-59f4aa99a368",
  },
  {
    kind: "failed",
    add: 13,
    remove: 14,
    iid: "95e3e803-c969-5e3a-9753-ea2ad22a9a33",
  },
] as const;

/**
 * Copy an event out of its native argument while the callback is on the stack. The argument is borrowed.
 * An Activated argument that cannot be read yields no event instead of a body click.
 */
function readToastEvent(
  runtime: ReturnType<typeof createToastRuntime>,
  kind: (typeof EVENTS)[number]["kind"],
  argument: Pointer,
  replyInputId: string | undefined,
  interactive: boolean,
): ToastEvent | undefined {
  if (kind === "clicked") {
    // A toast without buttons or reply box can only be activated by a body click, as before actions existed.
    return interactive
      ? readActivation(runtime, argument, replyInputId)
      : {
          kind: "activated",
          arguments: "",
          reply: undefined,
        };
  }
  const output = new Int32Array(1);
  checkToast(
    runtime.method(
      argument,
      6,
      [
        "ptr",
      ],
      ptr(output),
    ),
    "ToastEvent.Value",
  );
  if (kind === "failed") {
    return {
      kind: "failed",
      hresult: (output[0] ?? 0) >>> 0,
    };
  }
  const reasons = [
    "userCanceled",
    "applicationHidden",
    "timedOut",
  ] as const;
  return {
    kind: "dismissed",
    reason: reasons[output[0] ?? -1] ?? "unknown",
  };
}

/** Reject MSIX before choosing an explicit desktop AUMID. This never registers or changes app identity. */
function requireUnpackaged() {
  const kernel = dlopen("kernel32.dll", {
    ...pick(KERNEL32, "GetCurrentPackageFullName"),
  });
  try {
    const size = new Uint32Array(1);
    const result = kernel.symbols.GetCurrentPackageFullName(ptr(size), null);
    if (result === 0 || result === 122) {
      throw new BunawayError({
        code: "UNSUPPORTED",
        message: "Toast delivery requires an unpackaged desktop app identity.",
      });
    }
    if (result !== 15700) {
      throw new BunawayError({
        code: result === 5 ? "PERMISSION_DENIED" : "INTERNAL",
        message: "Windows could not query the app package identity.",
      });
    }
  } finally {
    kernel.close();
  }
}

/**
 * Own the app notifier, toast objects, event tokens and STA through explicit clear/disposal.
 * The UI host supplies the message pump. No COM activator, shortcut or protocol handler is installed.
 */
export function createWindowsToastDriver(appId: string): ToastDriver {
  requireUnpackaged();
  const runtime = createToastRuntime();
  let notifier: Pointer;
  let history: Pointer;
  try {
    const manager = runtime.factory(MANAGER, MANAGER_IID);
    try {
      notifier = runtime.string(appId, (id) =>
        runtime.object(
          (out) =>
            runtime.method(
              manager,
              7,
              [
                "ptr",
                "ptr",
              ],
              id,
              out,
            ),
          "CreateToastNotifierWithId",
        ),
      );
    } finally {
      runtime.release(manager);
    }
    try {
      const manager2 = runtime.factory(MANAGER, HISTORY_MANAGER_IID);
      try {
        history = runtime.object(
          (out) =>
            runtime.method(
              manager2,
              6,
              [
                "ptr",
              ],
              out,
            ),
          "ToastNotificationManager.History",
        );
      } finally {
        runtime.release(manager2);
      }
    } catch (error) {
      runtime.release(notifier);
      throw error;
    }
  } catch (error) {
    runtime.dispose();
    throw error;
  }
  type OwnedToast = ToastHandle & {
    identity: NotificationResult;
    toast: Pointer | undefined;
  };
  const owned = new Set<OwnedToast>();
  const failed = new Set<OwnedToast>();
  const drainFailed = () => {
    for (const owner of failed) {
      owner.detach();
      failed.delete(owner);
    }
  };
  let disposed = false;
  const ensureActive = () => {
    if (disposed) {
      throw new BunawayError({
        code: "CANCELLED",
        message: "Toast driver is disposed.",
      });
    }
  };
  function createToast(input: ResolvedNotification): Pointer {
    const document = runtime.activate("Windows.Data.Xml.Dom.XmlDocument");
    try {
      const io = runtime.query(document, XML_IO_IID);
      try {
        runtime.string(toastXml(input), (xml) =>
          checkToast(
            runtime.method(
              io,
              6,
              [
                "ptr",
              ],
              xml,
            ),
            "XmlDocument.LoadXml",
          ),
        );
      } finally {
        runtime.release(io);
      }
      const factory = runtime.factory(
        "Windows.UI.Notifications.ToastNotification",
        TOAST_FACTORY_IID,
      );
      try {
        return runtime.object(
          (out) =>
            runtime.method(
              factory,
              6,
              [
                "ptr",
                "ptr",
              ],
              document,
              out,
            ),
          "CreateToastNotification",
        );
      } finally {
        runtime.release(factory);
      }
    } finally {
      runtime.release(document);
    }
  }
  return {
    show(input, receive) {
      ensureActive();
      // A failed show can retain native callbacks without reaching the controller's active map.
      // Drain those owners before admitting more work, bounding this failure lane to one toast.
      drainFailed();
      const toast = createToast(input);
      type Subscription = {
        remove: number;
        token?: bigint | undefined;
        delegate: ReturnType<typeof createToastDelegate>;
      };
      const subscriptions: Subscription[] = [];
      let attached = true;
      const owner: OwnedToast = {
        identity: {
          id: input.id,
          group: input.group,
        },
        toast,
        detach() {
          attached = false;
          // Preserve unrevoked tokens and native references after a failure so cleanup can be retried.
          for (const subscription of subscriptions) {
            if (subscription.token !== undefined && owner.toast) {
              checkToast(
                runtime.method(
                  owner.toast,
                  subscription.remove,
                  [
                    "i64",
                  ],
                  subscription.token,
                ),
                "ToastNotification.RemoveEvent",
              );
              subscription.token = undefined;
            }
          }
          if (owner.toast) {
            runtime.release(owner.toast);
            owner.toast = undefined;
          }
          for (const subscription of subscriptions) {
            subscription.delegate.dispose();
          }
          owned.delete(owner);
        },
      };
      owned.add(owner);
      try {
        const properties = runtime.query(toast, TOAST2_IID);
        try {
          runtime.string(input.id, (id) =>
            checkToast(
              runtime.method(
                properties,
                6,
                [
                  "ptr",
                ],
                id,
              ),
              "ToastNotification.Tag",
            ),
          );
          runtime.string(input.group, (group) =>
            checkToast(
              runtime.method(
                properties,
                8,
                [
                  "ptr",
                ],
                group,
              ),
              "ToastNotification.Group",
            ),
          );
          checkToast(
            runtime.method(
              properties,
              10,
              [
                "u8",
              ],
              input.suppressPopup ? 1 : 0,
            ),
            "ToastNotification.SuppressPopup",
          );
        } finally {
          runtime.release(properties);
        }
        for (const event of EVENTS) {
          const delegate = createToastDelegate(event.iid, (argument) => {
            if (!attached) {
              return;
            }
            const value = readToastEvent(
              runtime,
              event.kind,
              argument,
              input.reply ? REPLY_INPUT_ID : undefined,
              input.actions.length > 0 || input.reply !== null,
            );
            if (!value) {
              return;
            }
            // Copy the value while arguments are alive, then leave the native callback stack before publishing.
            queueMicrotask(() => {
              if (attached) {
                receive(value);
              }
            });
          });
          const subscription: Subscription = {
            remove: event.remove,
            delegate,
          };
          subscriptions.push(subscription);
          const token = new BigInt64Array(1);
          checkToast(
            runtime.method(
              toast,
              event.add,
              [
                "ptr",
                "ptr",
              ],
              delegate.pointer,
              ptr(token),
            ),
            "ToastNotification.AddEvent",
          );
          subscription.token = token[0] ?? 0n;
        }
        checkToast(
          runtime.method(
            notifier,
            6,
            [
              "ptr",
            ],
            toast,
          ),
          "ToastNotifier.Show",
        );
        return owner;
      } catch (error) {
        try {
          owner.detach();
        } catch (cleanupError) {
          failed.add(owner);
          throw new AggregateError(
            [
              error,
              cleanupError,
            ],
            "Toast creation and callback cleanup failed.",
          );
        }
        throw error;
      }
    },
    clear(identity) {
      ensureActive();
      drainFailed();
      for (const owner of owned) {
        if (
          owner.toast &&
          owner.identity.id === identity.id &&
          owner.identity.group === identity.group
        ) {
          checkToast(
            runtime.method(
              notifier,
              7,
              [
                "ptr",
              ],
              owner.toast,
            ),
            "ToastNotifier.Hide",
          );
        }
      }
      runtime.string(identity.id, (id) =>
        runtime.string(identity.group, (group) =>
          runtime.string(appId, (app) =>
            checkToast(
              runtime.method(
                history,
                8,
                [
                  "ptr",
                  "ptr",
                  "ptr",
                ],
                id,
                group,
                app,
              ),
              "ToastHistory.RemoveGroupedTagWithId",
            ),
          ),
        ),
      );
    },
    list() {
      ensureActive();
      drainFailed();
      // IToastNotificationHistory2: GetHistory(6), GetHistoryWithId(7). Scoped to this app's AppUserModelID.
      const history2 = runtime.query(history, HISTORY2_IID);
      try {
        const items = runtime.string(appId, (app) =>
          runtime.object(
            (out) =>
              runtime.method(
                history2,
                7,
                [
                  "ptr",
                  "ptr",
                ],
                app,
                out,
              ),
            "ToastHistory.GetHistoryWithId",
          ),
        );
        try {
          // IVectorView<ToastNotification>: get_Size(7), GetAt(6).
          const size = new Uint32Array(1);
          checkToast(
            runtime.method(
              items,
              7,
              [
                "ptr",
              ],
              ptr(size),
            ),
            "ToastHistory.Size",
          );
          const result: NotificationResult[] = [];
          for (let index = 0; index < (size[0] ?? 0); index++) {
            const toast = runtime.object(
              (out) =>
                runtime.method(
                  items,
                  6,
                  [
                    "u32",
                    "ptr",
                  ],
                  index,
                  out,
                ),
              "ToastHistory.GetAt",
            );
            try {
              const properties = runtime.query(toast, TOAST2_IID);
              try {
                // IToastNotification2: get_Tag(7), get_Group(9).
                const text = (slot: number, stage: string) => {
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
                };
                const identity = notificationResultSchema.safeParse({
                  id: text(7, "ToastNotification.Tag"),
                  group: text(9, "ToastNotification.Group"),
                });
                // Items created by other code under the same app ID may lack a tag or use characters outside our contract.
                if (identity.success) {
                  result.push(identity.data);
                }
              } finally {
                runtime.release(properties);
              }
            } finally {
              runtime.release(toast);
            }
          }
          return result;
        } finally {
          runtime.release(items);
        }
      } finally {
        runtime.release(history2);
      }
    },
    clearAll() {
      ensureActive();
      drainFailed();
      for (const owner of owned) {
        if (owner.toast) {
          checkToast(
            runtime.method(
              notifier,
              7,
              [
                "ptr",
              ],
              owner.toast,
            ),
            "ToastNotifier.Hide",
          );
        }
      }
      // IToastNotificationHistory follows IInspectable: RemoveGroup(6), RemoveGroupWithId(7),
      // RemoveGroupedTagWithId(8, used by clear), RemoveGroupedTag(9), Remove(10), Clear(11), ClearWithId(12).
      // ClearWithId is scoped to this app's AppUserModelID, so it also removes records left by an earlier
      // process and never touches another app's notifications.
      runtime.string(appId, (app) =>
        checkToast(
          runtime.method(
            history,
            12,
            [
              "ptr",
            ],
            app,
          ),
          "ToastHistory.ClearWithId",
        ),
      );
    },
    dispose() {
      if (disposed) {
        return;
      }
      for (const owner of owned) {
        owner.detach();
      }
      failed.clear();
      runtime.release(history);
      runtime.release(notifier);
      runtime.dispose();
      disposed = true;
    },
  };
}
