import type { JsonValue } from "@bunaway/protocol";
import {
  MAX_PENDING_ACTIVATIONS,
  type TakenActivation,
} from "#notification/contract";
import {
  type ParsedActivation,
  parseActivationArguments,
} from "#notification/platforms/toast-activation-args";
import type { ActivatorCall } from "#notification/platforms/toast-com-activator";

/** The part of the toast controller the inbox asks first, because a toast of this run knows its `data`. */
export type LiveToasts = {
  activateFromActivator(parsed: ParsedActivation, typed: string): boolean;
};

/** A click on a notification this run did not show: only what the arguments carry, so `data` is null. */
function coldActivation(
  parsed: ParsedActivation,
  reply: string | null,
): TakenActivation {
  const { id, group, target } = parsed;
  if (target.kind === "body") {
    return {
      kind: "clicked",
      id,
      group,
      actionId: null,
      reply: null,
      data: null,
    };
  }
  return {
    kind: "actionInvoked",
    id,
    group,
    actionId: target.kind === "action" ? target.actionId : null,
    // A reply button without text still reports an empty reply, like a live toast.
    reply: target.kind === "reply" ? (reply ?? "") : reply,
    data: null,
  };
}

/**
 * Receive clicks from the Windows activator. A click on a toast this run showed goes to that toast.
 * Any other click (the one that started the app, or one on an earlier run's notification) is held for
 * the app until its first `takeActivations`, because an event sent before the app subscribed would be
 * lost. After that first call clicks are published as events directly.
 */
export function createActivationInbox(options: {
  appUserModelId: string;
  publish: (event: string, payload: JsonValue) => void;
  live: () => LiveToasts | undefined;
}) {
  const pending: TakenActivation[] = [];
  let taken = false;
  const publishNow = (activation: TakenActivation) => {
    if (activation.kind === "clicked") {
      options.publish("notification.clicked", {
        id: activation.id,
        group: activation.group,
        data: null,
      });
    } else {
      options.publish("notification.actionInvoked", {
        id: activation.id,
        group: activation.group,
        actionId: activation.actionId,
        reply: activation.reply,
        data: null,
      });
    }
  };
  return {
    /**
     * Route one validated activator call. A call for another app identity or with arguments this plugin
     * did not write is dropped: the activator is reachable by other local processes.
     */
    receive(call: ActivatorCall): void {
      if (
        call.appUserModelId.toLowerCase() !==
        options.appUserModelId.toLowerCase()
      ) {
        return;
      }
      const parsed = parseActivationArguments(call.arguments);
      if (!parsed) {
        return;
      }
      if (options.live()?.activateFromActivator(parsed, call.reply ?? "")) {
        return;
      }
      const activation = coldActivation(parsed, call.reply);
      if (taken) {
        publishNow(activation);
        return;
      }
      pending.push(activation);
      if (pending.length > MAX_PENDING_ACTIVATIONS) {
        pending.shift();
      }
    },
    /** Hand the held clicks to the app, oldest first, and publish later ones as events. */
    take(): TakenActivation[] {
      taken = true;
      return pending.splice(0);
    },
  };
}
