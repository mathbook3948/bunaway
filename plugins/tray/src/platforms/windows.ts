import { defineNativeAdapter, NativeEventWaiters } from "@bunaway/plugin";
import type { NativeTrayServices } from "@bunaway/plugin-api/native";
import { MAX_TRAY_WAITERS } from "@bunaway/plugin-api/native";
import { BunawayError, validateValue } from "@bunaway/protocol";
import { trayOperations } from "../contract.ts";
import { Tray } from "../tray.ts";

function requireTray(
  services: NativeTrayServices | undefined,
): NativeTrayServices {
  if (!services) {
    throw new BunawayError({
      code: "UNSUPPORTED",
      message: "Tray services are unavailable.",
    });
  }
  return services;
}

/** The selected package creates native residency; the host retains retryable cleanup ownership. */
export const createOperations = defineNativeAdapter(trayOperations, {
  setup(environment) {
    const services = environment.tray;
    services?.initialize?.(
      ({ windows, tooltip, receive, notify, retain }) =>
        new Tray(windows, tooltip, receive, notify, retain),
    );
    const notifications = new NativeEventWaiters<
      ReturnType<typeof trayOperations.waitForEvent.output.parse>
    >(MAX_TRAY_WAITERS);
    const unsubscribe = services?.subscribe((event) => {
      notifications.publish(event);
      services.emit("tray.input", validateValue({}, event));
    });
    return {
      services,
      notifications,
      unsubscribe,
    };
  },
  handlers: {
    get: (_input, _context, { services }) => requireTray(services).get(),
    getBounds: (_input, _context, { services }) =>
      requireTray(services).getBounds(),
    setTooltip({ tooltip }, _context, { services }) {
      requireTray(services).setTooltip(tooltip);
      return null;
    },
    setIcon({ ico }, _context, { services }) {
      requireTray(services).setIcon(ico);
      return null;
    },
    setClickBehavior(
      { showOnLeftClick, menuOnRightClick },
      _context,
      { services },
    ) {
      requireTray(services).setClickBehavior(showOnLeftClick, menuOnRightClick);
      return null;
    },
    focus: (_input, _context, { services }) => requireTray(services).focus(),
    waitForEvent(_input, context, { services, notifications }) {
      requireTray(services);
      return notifications.wait(context.signal);
    },
  },
  dispose({ notifications, unsubscribe }) {
    notifications.dispose();
    unsubscribe?.();
  },
});
