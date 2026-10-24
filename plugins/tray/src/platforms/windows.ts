import { type NativeEnvironment, NativeEventWaiters } from "@bunaway/plugin";
import {
  MAX_TRAY_WAITERS,
  type NativeTrayOwner,
  type NativeTrayServices,
} from "@bunaway/plugin-api/native";
import { BunawayError, validateValue } from "@bunaway/protocol";
import type { z } from "zod";
import type { TrayBalloon, trayEventSchema } from "#tray/contract";
import { readTrayIconFile } from "#tray/platforms/windows-icon-file";
import { Tray } from "#tray/platforms/windows-tray";

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

/** The host-retained owner plus the balloon controls this plugin reaches through its own factory. */
export type BalloonTrayOwner = NativeTrayOwner &
  Pick<Tray, "displayBalloon" | "removeBalloon">;

/** Creates the tray owner; injectable so tests can observe wiring without a shell icon. */
export type TrayFactory = (
  ...args: ConstructorParameters<typeof Tray>
) => BalloonTrayOwner;

type CreatedTray = {
  tray: BalloonTrayOwner | undefined;
};

function requireBalloonTray(state: {
  services: NativeTrayServices | undefined;
  created: CreatedTray;
}): BalloonTrayOwner {
  requireTray(state.services);
  if (!state.created.tray) {
    throw new BunawayError({
      code: "UNSUPPORTED",
      message: "The app has no configured tray.",
    });
  }
  return state.created.tray;
}

/** The selected package creates native residency; the host retains cleanup ownership. */
export function initialize(environment: NativeEnvironment) {
  return initializeWith(environment, (...args) => new Tray(...args));
}

/** Wires tray input and hover delivery around the owner returned by `createTray`. */
export function initializeWith(
  environment: NativeEnvironment,
  createTray: TrayFactory,
) {
  const services = environment.tray;
  const hover = {
    open: true,
  };
  // The factory result is the only path to the balloon controls; the host services stay unchanged.
  const created: CreatedTray = {
    tray: undefined,
  };
  services?.initialize?.(
    ({ windows, tooltip, icon, resources, receive, notify, retain }) => {
      // Hover and balloon events are view-only with no waiter. The host Tray outlives this plugin,
      // so stop after dispose.
      created.tray = createTray(
        windows,
        tooltip,
        receive,
        notify,
        retain,
        (event) => {
          if (hover.open) {
            services.emit("tray.hover", validateValue({}, event));
          }
        },
        (event) => {
          if (hover.open) {
            services.emit("tray.balloon", validateValue({}, event));
          }
        },
        // The host passes the declared path; reading it here keeps file access out of the host core.
        icon === undefined ? undefined : readTrayIconFile(resources, icon),
      );
      return created.tray;
    },
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
    created,
    hover,
    notifications,
    unsubscribe,
  };
}

type State = ReturnType<typeof initializeWith>;

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

export function setVisible(state: State, visible: boolean): null {
  requireTray(state.services).setVisible(visible);
  return null;
}

export function focus(state: State) {
  return requireTray(state.services).focus();
}

/** Blocks until the attached menu closes. The choice arrives as `menu.clicked`, not as a result. */
export function popUpContextMenu(
  state: State,
  position: {
    x: number;
    y: number;
  } | null,
  signal?: AbortSignal,
): null {
  // Without a request signal only host shutdown can interrupt the native loop.
  requireTray(state.services).popUpContextMenu(
    position,
    signal ?? new AbortController().signal,
  );
  return null;
}

/** Shows or replaces the icon's balloon. Success means the shell accepted it, not that it appeared. */
export function displayBalloon(state: State, balloon: TrayBalloon): null {
  requireBalloonTray(state).displayBalloon(balloon);
  return null;
}

/** Withdraws the current balloon; a no-op when none is showing. */
export function removeBalloon(state: State): null {
  requireBalloonTray(state).removeBalloon();
  return null;
}

export function waitForEvent(state: State, signal?: AbortSignal) {
  requireTray(state.services);
  return state.notifications.wait(signal);
}

export function dispose(state: State): void {
  state.hover.open = false;
  state.notifications.dispose();
  state.unsubscribe?.();
}
