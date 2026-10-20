import type { WindowResizeDirection } from "@bunaway/plugin-api/native";
import { monitorServices } from "./monitors.ts";
import { user } from "./win32-bindings.ts";
import {
  HIT_TEST,
  HTCAPTION,
  screenPointParam,
  WM_NCLBUTTONDOWN,
} from "./window-drag.ts";

const VK_LBUTTON = 0x01;
const VK_RBUTTON = 0x02;
const SM_SWAPBUTTON = 23;
const DEFAULT_DPI = 96;

/** Physical state of the logical primary button; swapped mice report it through the right key. */
export function primaryButtonDown(): boolean {
  const swapped = user.symbols.GetSystemMetricsForDpi(
    SM_SWAPBUTTON,
    DEFAULT_DPI,
  );
  const key = swapped ? VK_RBUTTON : VK_LBUTTON;
  return (user.symbols.GetAsyncKeyState(key) & 0x8000) !== 0;
}

/**
 * Release any capture held by this thread (the WebView child usually owns it while the pointer is
 * pressed in the page) and post the non-client press at the cursor. The loop then runs on the UI
 * thread and ends on button release; the caller owns the state checks.
 */
export function beginSystemLoop(
  window: bigint,
  direction: WindowResizeDirection | null,
): void {
  const { x, y } = monitorServices.cursor();
  user.symbols.ReleaseCapture();
  const posted = user.symbols.PostMessageW(
    window,
    WM_NCLBUTTONDOWN,
    BigInt(direction ? HIT_TEST[direction] : HTCAPTION),
    screenPointParam(x, y),
  );
  if (!posted) {
    throw new Error("PostMessageW failed to start the window drag.");
  }
}
