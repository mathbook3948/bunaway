import { attemptAll } from "@bunaway/plugin";
import { BunawayError, type JsonValue } from "@bunaway/protocol";
import {
  MAX_ACTIVE_TOASTS,
  MAX_REPLY_LENGTH,
  type NotificationResult,
  type ResolvedNotification,
  type ResolvedScheduledNotification,
  type ScheduledNotification,
  type ToastEvent,
} from "#notification/contract";
import {
  type ActivationTarget,
  activationArguments,
  type ParsedActivation,
  parseActivationArguments,
} from "#notification/platforms/toast-activation-args";

/** The fields that shape toast XML, shared by `show` and `schedule`. */
type ToastContent = Omit<ResolvedNotification, "expiresAfterSeconds">;

/** Input id of the reply text box in the toast XML. */
export const REPLY_INPUT_ID = "reply";

type Activation =
  | {
      kind: "body";
    }
  | {
      kind: "action";
      actionId: string | null;
      reply: string | null;
    };

/**
 * Map a parsed click on a live toast to a public activation. Only buttons this toast declared are
 * accepted. `reply` is the text the driver read for the reply input, or undefined when it reported none.
 * An undeclared button and a reply over the limit yield no event, because truncating would change what
 * the user typed.
 */
function resolveTarget(
  input: ResolvedNotification,
  target: ActivationTarget,
  typed: string | undefined,
): Activation | undefined {
  if (target.kind === "body") {
    return {
      kind: "body",
    };
  }
  // A driver that reports no text for a toast with a reply box violates the event contract: publish nothing.
  const reply = input.reply ? typed : null;
  if (
    reply === undefined ||
    (reply !== null && reply.length > MAX_REPLY_LENGTH)
  ) {
    return undefined;
  }
  if (target.kind === "reply") {
    return input.reply
      ? {
          kind: "action",
          actionId: null,
          reply,
        }
      : undefined;
  }
  return input.actions.some((action) => action.id === target.actionId)
    ? {
        kind: "action",
        actionId: target.actionId,
        reply,
      }
    : undefined;
}

/**
 * Map the Activated arguments of a toast this process showed. An empty argument is the body click of a
 * toast without buttons, which has no launch string to read. Otherwise the arguments must be the ones
 * this toast was built with: another identity or an unknown format yields no event.
 */
function resolveActivation(
  input: ResolvedNotification,
  event: Extract<
    ToastEvent,
    {
      kind: "activated";
    }
  >,
): Activation | undefined {
  if (event.arguments === "") {
    return {
      kind: "body",
    };
  }
  const parsed = parseActivationArguments(event.arguments);
  if (!parsed || parsed.id !== input.id || parsed.group !== input.group) {
    return undefined;
  }
  return resolveTarget(input, parsed.target, event.reply);
}

/** Native resources for one toast. detach must be safe to retry after partial cleanup. */
export type ToastHandle = {
  detach(): void;
};
/** App-scoped driver. Native callbacks must copy arguments before returning to Windows. */
export type ToastDriver = {
  show(
    input: ResolvedNotification,
    receive: (event: ToastEvent) => void,
  ): ToastHandle;
  clear(identity: NotificationResult): void;
  /** Hide the owned toasts of one group and clear that group's history of the host app ID, including earlier processes. */
  clearGroup(group: string): void;
  /** Hide every toast owned by this driver and clear all history of the host app ID, including earlier processes. */
  clearAll(): void;
  /** Identities of the host app ID's history items, including earlier processes. Items without a valid identity are omitted. */
  list(): NotificationResult[];
  /** Hand the toast to the OS schedule, replacing one with the same identity. The OS shows it after this process exits. */
  schedule(input: ResolvedScheduledNotification): void;
  /** Not yet delivered scheduled toasts of the host app ID, including earlier processes. */
  listScheduled(): ScheduledNotification[];
  /** Remove the scheduled toast with this identity. A missing schedule is not an error. */
  cancelScheduled(identity: NotificationResult): void;
  dispose(): void;
};

/** Own live callback generations and clear session toasts before releasing the native driver. */
export function createToastController(
  driver: ToastDriver,
  publish: (event: string, payload: JsonValue) => void,
  // Native STA controllers supply one bounded synchronous settling budget per operation.
  beginSettle: () => (cleanup: () => void) => void = () => (cleanup) =>
    cleanup(),
) {
  type Entry = {
    input: ResolvedNotification;
    handle?: ToastHandle;
    active: boolean;
    /**
     * Route that delivered the first click. Windows reports a click to the toast object and, once an
     * activator is registered, possibly also to the activator. The activator route ignores a toast the
     * object route already delivered and the object route ignores one the activator delivered, so one
     * click publishes once. Each duplicate is consumed once and clears the mark, so a later click that
     * reaches only one route is published. Repeated clicks through the object route are all published.
     */
    activatedBy?: "toast" | "activator";
  };
  const entries = new Map<string, Entry>();
  const retired = new Set<ToastHandle>();
  let stopping = false;
  let disposed = false;
  const key = ({ id, group }: NotificationResult) => `${group}/${id}`;
  const active = () => {
    if (stopping) {
      throw new BunawayError({
        code: "CANCELLED",
        message: "Toast adapter is stopping.",
      });
    }
  };
  const drain = () => {
    for (const handle of retired) {
      handle.detach();
      retired.delete(handle);
    }
  };
  const publishActivation = (
    input: ResolvedNotification,
    activation: Activation,
  ) => {
    const identity = {
      id: input.id,
      group: input.group,
    };
    if (activation.kind === "body") {
      publish("notification.clicked", {
        ...identity,
        data: input.data,
      });
    } else {
      publish("notification.actionInvoked", {
        ...identity,
        actionId: activation.actionId,
        reply: activation.reply,
        data: input.data,
      });
    }
  };
  const retire = (entry: Entry) => {
    entry.active = false;
    if (entry.handle) {
      retired.add(entry.handle);
    }
  };
  return {
    show(input: ResolvedNotification): NotificationResult {
      active();
      const settle = beginSettle();
      settle(drain);
      const identity = {
        id: input.id,
        group: input.group,
      };
      const id = key(identity);
      const previous = entries.get(id);
      if (!previous && entries.size >= MAX_ACTIVE_TOASTS) {
        throw new BunawayError({
          code: "BUSY",
          message: "Clear an active notification before showing another.",
        });
      }
      const entry: Entry = {
        input: structuredClone(input),
        active: true,
      };
      // Deferred callbacks cannot attribute an old toast's events to its replacement.
      entry.handle = driver.show(input, (event) => {
        if (stopping || !entry.active || entries.get(id) !== entry) {
          return;
        }
        if (event.kind === "activated") {
          if (entry.activatedBy === "activator") {
            // The duplicate of a click the activator already published: consumed, so the next click counts.
            entry.activatedBy = undefined;
            return;
          }
          const activation = resolveActivation(entry.input, event);
          if (activation) {
            entry.activatedBy = "toast";
            publishActivation(entry.input, activation);
          }
        } else if (event.kind === "dismissed") {
          publish("notification.dismissed", {
            ...identity,
            reason: event.reason,
          });
        } else {
          publish("notification.failed", {
            ...identity,
            hresult: event.hresult,
          });
        }
      });
      entries.set(id, entry);
      if (previous) {
        retire(previous);
      }
      // Keep retired ownership if revocation is still pending. The next operation or dispose retries it.
      // Show has already succeeded, so cleanup must not turn its acknowledgement into an ambiguous failure.
      try {
        settle(drain);
      } catch {
        /* Retained in retired until the next explicit operation. */
      }
      return identity;
    },
    /**
     * Deliver a click reported by the activator to the toast of this run that owns its identity, so it
     * carries that toast's `data` and is checked against the buttons it declared.
     * Returns false when this run has no such toast: the caller then handles it as a click on a
     * notification of an earlier run. A toast the object route already delivered, or one this run
     * rejects as undeclared, is consumed without an event.
     */
    activateFromActivator(parsed: ParsedActivation, typed: string): boolean {
      const entry = entries.get(key(parsed));
      if (!entry) {
        return false;
      }
      if (stopping) {
        return true;
      }
      if (entry.activatedBy === "toast") {
        // The duplicate of a click the object route already published: consumed, so the next click counts.
        entry.activatedBy = undefined;
        return true;
      }
      const activation = resolveTarget(entry.input, parsed.target, typed);
      if (activation) {
        entry.activatedBy = "activator";
        publishActivation(entry.input, activation);
      }
      return true;
    },
    clear(identity: NotificationResult): null {
      active();
      const settle = beginSettle();
      settle(drain);
      // This also clears a matching history item from an earlier process, without clearing other app items.
      driver.clear(identity);
      const id = key(identity);
      const entry = entries.get(id);
      if (entry) {
        retire(entry);
        entries.delete(id);
      }
      settle(drain);
      return null;
    },
    list(): NotificationResult[] {
      active();
      return driver.list();
    },
    /**
     * Schedules are owned by the OS: they are not tracked in `entries`, publish no toast object events (a click arrives through the activator) and survive
     * `dispose`, so the app can be closed before the delivery time.
     */
    schedule(input: ResolvedScheduledNotification): NotificationResult {
      active();
      if (input.deliverAt <= Date.now()) {
        throw new BunawayError({
          code: "INVALID_ARGUMENT",
          message: "deliverAt must be in the future.",
        });
      }
      driver.schedule(input);
      return {
        id: input.id,
        group: input.group,
      };
    },
    listScheduled(): ScheduledNotification[] {
      active();
      return driver.listScheduled();
    },
    cancelScheduled(identity: NotificationResult): null {
      active();
      driver.cancelScheduled(identity);
      return null;
    },
    clearGroup(group: string): null {
      active();
      const settle = beginSettle();
      settle(drain);
      // A driver failure leaves every entry owned so the caller can retry.
      driver.clearGroup(group);
      // Retiring discards late callbacks. Like clear, no synthetic dismissed event is published.
      for (const [id, entry] of [
        ...entries,
      ]) {
        if (entry.input.group === group) {
          retire(entry);
          entries.delete(id);
        }
      }
      settle(drain);
      return null;
    },
    clearAll(): null {
      active();
      const settle = beginSettle();
      settle(drain);
      // A driver failure leaves every entry owned so the caller can retry.
      driver.clearAll();
      // Retiring discards late callbacks. Like clear, no synthetic dismissed event is published.
      for (const entry of entries.values()) {
        retire(entry);
      }
      entries.clear();
      settle(drain);
      return null;
    },
    dispose(): void {
      if (disposed) {
        return;
      }
      stopping = true;
      attemptAll(
        [
          ...[
            ...entries,
          ].map(([id, entry]) => () => {
            entry.active = false;
            driver.clear(entry.input);
            retire(entry);
            entries.delete(id);
          }),
          drain,
        ],
        "Toast cleanup failed.",
      );
      driver.dispose();
      disposed = true;
    },
  };
}

const escapeXml = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

/** Convert a validated drive-absolute path to file:/// with each segment percent-encoded. */
export function toastFileUri(path: string): string {
  const [drive = "", ...segments] = path.replaceAll("\\", "/").split("/");
  return `file:///${drive}/${segments.map(encodeURIComponent).join("/")}`;
}

/** Reply text box and buttons. Windows renders the input only when a button references it with hint-inputId. */
function actionsXml(input: ToastContent): string {
  const button = (label: string, argument: string, inputId = "") =>
    `<action content="${escapeXml(label)}" arguments="${escapeXml(argument)}" activationType="foreground"${inputId}/>`;
  const reply = input.reply
    ? `<input id="${REPLY_INPUT_ID}" type="text" placeHolderContent="${escapeXml(input.reply.placeholder)}"/>${button(
        input.reply.buttonLabel,
        activationArguments(input, {
          kind: "reply",
        }),
        ` hint-inputId="${REPLY_INPUT_ID}"`,
      )}`
    : "";
  const buttons = input.actions
    .map((action) =>
      button(
        action.label,
        activationArguments(input, {
          kind: "action",
          actionId: action.id,
        }),
      ),
    )
    .join("");
  // A reminder toast stays only while it has a button, so a toast without one gets the system dismiss
  // button (empty content selects the localized label) and keeps its own buttons otherwise.
  const dismiss =
    input.timeoutType === "never" && !reply && !buttons
      ? '<action content="" arguments="dismiss" activationType="system"/>'
      : "";
  const all = `${reply}${buttons}${dismiss}`;
  return all ? `<actions>${all}</actions>` : "";
}

/**
 * Build toast XML. Text and file URIs are escaped, and media paths are validated local files.
 * A looping sound needs duration="long", otherwise Windows plays it once with the short toast.
 * timeoutType "never" maps to scenario="reminder", which keeps the popup until the user dismisses it.
 * Caller data is never treated as markup or an executable activation route.
 */
export function toastXml(input: ToastContent): string {
  const image = (path: string, placement: string) =>
    `<image ${placement}src="${escapeXml(toastFileUri(path))}"/>`;
  const media = [
    input.icon ? image(input.icon, 'placement="appLogoOverride" ') : "",
    input.image
      ? image(
          input.image,
          input.imagePlacement === "hero" ? 'placement="hero" ' : "",
        )
      : "",
  ].join("");
  let audio = "";
  if (input.silent) {
    audio = '<audio silent="true"/>';
  } else if (input.sound) {
    audio = `<audio src="ms-winsoundevent:Notification.${input.sound}"${input.soundLoop ? ' loop="true"' : ""}/>`;
  }
  // The launch string is what Windows hands back for a body click, including after this process exited.
  const launch = escapeXml(
    activationArguments(input, {
      kind: "body",
    }),
  );
  const attributes = ` launch="${launch}"${input.timeoutType === "never" ? ' scenario="reminder"' : ""}${input.soundLoop ? ' duration="long"' : ""}`;
  return `<toast${attributes}><visual><binding template="ToastGeneric">${media}<text>${escapeXml(input.title)}</text><text>${escapeXml(input.body)}</text></binding></visual>${actionsXml(input)}${audio}</toast>`;
}
