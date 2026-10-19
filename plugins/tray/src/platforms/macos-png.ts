import { BunawayError } from "@bunaway/protocol";
import { MAX_MACOS_TRAY_IMAGE_SIDE_PIXELS } from "#tray/contract";

/** The eight bytes every PNG file starts with. */
const PNG_SIGNATURE = Buffer.from([
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
]);
/** After the signature come the IHDR length and type, then width and height as big-endian 32-bit values. */
const IHDR_TYPE_OFFSET = 12;
const WIDTH_OFFSET = 16;
const HEIGHT_OFFSET = 20;
const HEADER_BYTES = 24;

function invalid(message: string): never {
  throw new BunawayError({
    code: "INVALID_ARGUMENT",
    message,
  });
}

/**
 * Reads the pixel size from the PNG header and rejects anything that is not a PNG or exceeds the
 * menu bar bound, before the bytes reach AppKit's decoder. A header that passes can still fail to
 * decode; the binding reports that as the same error.
 */
export function readPngSize(png: Uint8Array): {
  width: number;
  height: number;
} {
  const bytes = Buffer.from(png.buffer, png.byteOffset, png.byteLength);
  if (
    bytes.length < HEADER_BYTES ||
    !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) ||
    bytes.toString("latin1", IHDR_TYPE_OFFSET, WIDTH_OFFSET) !== "IHDR"
  ) {
    invalid("The tray image must be a PNG.");
  }
  const width = bytes.readUInt32BE(WIDTH_OFFSET);
  const height = bytes.readUInt32BE(HEIGHT_OFFSET);
  if (
    width === 0 ||
    height === 0 ||
    width > MAX_MACOS_TRAY_IMAGE_SIDE_PIXELS ||
    height > MAX_MACOS_TRAY_IMAGE_SIDE_PIXELS
  ) {
    invalid(
      `The tray image must be 1 to ${MAX_MACOS_TRAY_IMAGE_SIDE_PIXELS} pixels on each side.`,
    );
  }
  return {
    width,
    height,
  };
}
