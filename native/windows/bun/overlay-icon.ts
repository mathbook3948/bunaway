import {
  parseNativeIco,
  selectNativeIcoFrame,
} from "@bunaway/plugin-api/native";
import { BunawayError } from "@bunaway/protocol";

/**
 * Validate base64 ICO bytes with the shared ICO contract and return a DWORD-aligned copy of the frame
 * to draw at `size` pixels, ready for `CreateIconFromResourceEx`. Native callers bypass the plugin
 * schema, so the whole ICO is validated again here. Throws INVALID_ARGUMENT for an unusable image.
 */
export function overlayIconImage(ico: string, size: number): Buffer {
  const frame = selectNativeIcoFrame(parseNativeIco(ico) ?? [], size);
  if (!frame) {
    throw new BunawayError({
      code: "INVALID_ARGUMENT",
      message: "Invalid overlay ICO image.",
    });
  }
  // The decoded frame borrows the ICO buffer at an arbitrary offset.
  return Buffer.from(frame.data);
}
