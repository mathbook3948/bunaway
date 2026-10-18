import { dlopen } from "bun:ffi";
import { pick, USER32, USER32_MENUS } from "@bunaway/plugin/win32";
/** Bind only the notification icon and popup integration owned by this tray. */
export function openTrayBindings() {
  return dlopen("user32.dll", {
    ...pick(
      USER32,
      "RegisterWindowMessageW",
      "DestroyIcon",
      "GetCursorPos",
      "SetForegroundWindow",
      "PostMessageW",
      "SetTimer",
      "KillTimer",
    ),
    ...pick(USER32_MENUS, "TrackPopupMenuEx"),
    EndMenu: {
      args: [],
      returns: "i32",
    },
  });
}
