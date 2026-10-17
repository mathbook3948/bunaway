import {
  parseNativeIco,
  selectNativeIcoFrame,
} from "@bunaway/plugin-api/native";
import { BunawayError } from "@bunaway/protocol";

/** Decode a bounded canonical ICO and select its highest-resolution frame without file I/O. */
export function trayIconImage(ico: string): Buffer {
  const frame = selectNativeIcoFrame(
    parseNativeIco(ico) ?? [],
    Number.POSITIVE_INFINITY,
  );
  if (!frame) {
    throw new BunawayError({
      code: "INVALID_ARGUMENT",
      message: "Invalid tray ICO image.",
    });
  }
  return frame.data;
}
