import {
  type NativeAdapter,
  type NativeEnvironment,
  NativeEventWaiters,
} from "@bunaway/plugin";
import { MAX_TRAY_WAITERS } from "@bunaway/plugin-api/native";
import { BunawayError, type JsonValue, validateValue } from "@bunaway/protocol";
import { trayOperations } from "../contract.ts";

/** Own the notification subscription; the host retains the tray's HWND, icon and lifetime. */
export function createOperations(
  environment: NativeEnvironment,
): NativeAdapter {
  const services = environment.tray;
  const notifications = new NativeEventWaiters<JsonValue>(MAX_TRAY_WAITERS);
  const unsubscribe = services?.subscribe((event) => {
    const payload = validateValue({}, event);
    notifications.publish(payload);
    services.emit("tray.input", payload);
  });
  let disposed = false;
  return {
    execute() {
      throw new BunawayError({
        code: "UNSUPPORTED",
        message: "Tray controls require UI execution.",
      });
    },
    executeUI(name, input, _source, context) {
      if (disposed || context.signal?.aborted) {
        throw new BunawayError({
          code: "CANCELLED",
          message: "Tray operation cancelled.",
        });
      }
      if (!context.permissions.permissions.includes(name)) {
        throw new BunawayError({
          code: "PERMISSION_DENIED",
          message: "Tray permission denied.",
        });
      }
      if (!services) {
        throw new BunawayError({
          code: "UNSUPPORTED",
          message: "Tray services are unavailable.",
        });
      }
      const parse = <T>(run: () => T): T => {
        try {
          return run();
        } catch {
          throw new BunawayError({
            code: "INVALID_ARGUMENT",
            message: "Invalid tray input.",
          });
        }
      };
      switch (name) {
        case "tray.get":
          parse(() => trayOperations.get.input.parse(input));
          return validateValue({}, services.get());
        case "tray.getBounds":
          parse(() => trayOperations.getBounds.input.parse(input));
          return validateValue({}, services.getBounds());
        case "tray.setTooltip":
          services.setTooltip(
            parse(() => trayOperations.setTooltip.input.parse(input)).tooltip,
          );
          return null;
        case "tray.setIcon":
          services.setIcon(
            parse(() => trayOperations.setIcon.input.parse(input)).ico,
          );
          return null;
        case "tray.setClickBehavior": {
          const value = parse(() =>
            trayOperations.setClickBehavior.input.parse(input),
          );
          services.setClickBehavior(
            value.showOnLeftClick,
            value.menuOnRightClick,
          );
          return null;
        }
        case "tray.focus":
          parse(() => trayOperations.focus.input.parse(input));
          return services.focus();
        case "tray.waitForEvent":
          parse(() => trayOperations.waitForEvent.input.parse(input));
          return notifications.wait(context.signal);
        default:
          throw new BunawayError({
            code: "UNSUPPORTED",
            message: "Tray operation is not registered.",
          });
      }
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      notifications.dispose();
      unsubscribe?.();
    },
  };
}
