import { type NativeEnvironment, NativeEventWaiters } from "@bunaway/plugin";
import type { NativeTrayServices } from "@bunaway/plugin-api/native";
import { MAX_TRAY_WAITERS } from "@bunaway/plugin-api/native";
import { BunawayError, validateValue } from "@bunaway/protocol";
import type { z } from "zod";
import type { trayEventSchema } from "../contract.ts";
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

/** The selected package creates native residency; the host retains cleanup ownership. */
export function initialize(environment: NativeEnvironment) {
  const services = environment.tray;
  services?.initialize?.(
    ({ windows, tooltip, receive, notify, retain }) =>
      new Tray(windows, tooltip, receive, notify, retain),
  );
  const notifications = new NativeEventWaiters<
    z.output<typeof trayEventSchema>
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
}

type State = ReturnType<typeof initialize>;

export function get(state: State) {
  return requireTray(state.services).get();
}

export function getBounds(state: State) {
  return requireTray(state.services).getBounds();
}

export function setTooltip(state: State, tooltip: string): null {
  requireTray(state.services).setTooltip(tooltip);
  return null;
}

export function setIcon(state: State, ico: string | null): null {
  requireTray(state.services).setIcon(ico);
  return null;
}

export function setClickBehavior(
  state: State,
  showOnLeftClick: boolean,
  menuOnRightClick: boolean,
): null {
  requireTray(state.services).setClickBehavior(
    showOnLeftClick,
    menuOnRightClick,
  );
  return null;
}

export function focus(state: State) {
  return requireTray(state.services).focus();
}

export function waitForEvent(state: State, signal?: AbortSignal) {
  requireTray(state.services);
  return state.notifications.wait(signal);
}

export function dispose(state: State): void {
  state.notifications.dispose();
  state.unsubscribe?.();
}
