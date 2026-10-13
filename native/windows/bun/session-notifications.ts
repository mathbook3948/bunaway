import { dlopen } from "bun:ffi";
import assert from "node:assert/strict";

/** Owns opt-in WTS notifications for the hidden HWND, restricted to the current session. */
export function createSessionNotifications(hwnd: bigint) {
  const native = dlopen("wtsapi32.dll", {
    WTSRegisterSessionNotification: {
      args: [
        "u64",
        "u32",
      ],
      returns: "i32",
    },
    WTSUnRegisterSessionNotification: {
      args: [
        "u64",
      ],
      returns: "i32",
    },
  });
  let registered = false;
  try {
    assert(
      native.symbols.WTSRegisterSessionNotification(hwnd, 0),
      "WTS session registration failed.",
    );
    registered = true;
  } catch (error) {
    native.close();
    throw error;
  }
  return {
    /** Failed unregister retains the DLL for a retry; the HWND owner must still destroy its window. */
    dispose() {
      if (!registered) {
        return;
      }
      assert(
        native.symbols.WTSUnRegisterSessionNotification(hwnd),
        "WTS session unregister failed.",
      );
      registered = false;
      native.close();
    },
    /** Release the retained DLL after the owning HWND has been destroyed, including unregister failure. */
    detached() {
      if (!registered) {
        return;
      }
      registered = false;
      native.close();
    },
  };
}
