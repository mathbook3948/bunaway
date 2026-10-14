import { dlopen } from "bun:ffi";
/** Bind only the notification icon and popup integration owned by this tray. */
export function openTrayBindings() {
  return dlopen("user32.dll", {
    RegisterWindowMessageW: {
      args: [
        "ptr",
      ],
      returns: "u32",
    },
    DestroyIcon: {
      args: [
        "u64",
      ],
      returns: "i32",
    },
    GetCursorPos: {
      args: [
        "ptr",
      ],
      returns: "i32",
    },
    TrackPopupMenuEx: {
      args: [
        "u64",
        "u32",
        "i32",
        "i32",
        "u64",
        "ptr",
      ],
      returns: "u32",
    },
    SetForegroundWindow: {
      args: [
        "u64",
      ],
      returns: "i32",
    },
    PostMessageW: {
      args: [
        "u64",
        "u32",
        "u64",
        "i64",
      ],
      returns: "i32",
    },
  });
}
