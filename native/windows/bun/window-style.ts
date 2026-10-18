import type { WindowSpec } from "@bunaway/plugin-api/native";

export const WS_OVERLAPPEDWINDOW = 0x00cf0000;
export const WS_CAPTION = 0x00c00000n;
export const WS_EX_TOOLWINDOW = 0x80n;
export const WS_EX_LAYERED = 0x80000n;
export const WS_EX_NOACTIVATE = 0x08000000n;
export const WS_EX_TOPMOST = 0x8n;

/** Use the same styles for creation and DPI-aware initial frame measurement. */
export function initialWindowStyles(
  options: Pick<
    WindowSpec["window"],
    "titlebar" | "alwaysOnTop" | "skipTaskbar" | "focusable"
  >,
) {
  // Retain WS_THICKFRAME, WS_SYSMENU and caption-button policies for native resizing,
  // keyboard system menu, maximize and fullscreen restoration. Only remove the caption.
  return {
    style:
      options.titlebar === "custom"
        ? BigInt(WS_OVERLAPPEDWINDOW) & ~WS_CAPTION
        : BigInt(WS_OVERLAPPEDWINDOW),
    exStyle:
      (options.focusable === false ? WS_EX_NOACTIVATE : 0n) |
      (options.alwaysOnTop ? WS_EX_TOPMOST : 0n) |
      (options.skipTaskbar ? WS_EX_TOOLWINDOW : 0n),
  };
}
