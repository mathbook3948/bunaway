import { BunawayError } from "@bunaway/protocol";

/** Same decoded bound as the tray `setIcon` contract, applied again because native callers bypass the plugin schema. */
const MAX_ICO_BYTES = 65_536;
const ICO_HEADER_BYTES = 6;
const ICO_ENTRY_BYTES = 16;
const MAX_ICO_FRAMES = 32;
/** An ICO directory stores 256 as 0 in its one-byte width and height fields. */
const ICO_LARGE_DIMENSION = 256;

function invalid(): never {
  throw new BunawayError({
    code: "INVALID_ARGUMENT",
    message: "Invalid overlay ICO image.",
  });
}

/**
 * Decode canonical base64 ICO bytes and return the frame best suited to a `size` pixel square: the smallest
 * frame that is at least `size` wide, otherwise the largest. Windows then scales the frame to `size`.
 * Only the directory is validated here; the image data itself is validated by the shell icon creation.
 */
export function selectOverlayFrame(ico: string, size: number): Buffer {
  const bytes = Buffer.from(ico, "base64");
  if (
    bytes.length < ICO_HEADER_BYTES + ICO_ENTRY_BYTES ||
    bytes.length > MAX_ICO_BYTES ||
    bytes.toString("base64") !== ico ||
    bytes.readUInt16LE(0) !== 0 ||
    bytes.readUInt16LE(2) !== 1
  ) {
    return invalid();
  }
  const count = bytes.readUInt16LE(4);
  const headerSize = ICO_HEADER_BYTES + count * ICO_ENTRY_BYTES;
  if (count < 1 || count > MAX_ICO_FRAMES || bytes.length < headerSize) {
    return invalid();
  }
  let selected:
    | {
        image: Buffer;
        width: number;
      }
    | undefined;
  for (let index = 0; index < count; index++) {
    const entry = ICO_HEADER_BYTES + index * ICO_ENTRY_BYTES;
    const width = bytes.readUInt8(entry) || ICO_LARGE_DIMENSION;
    const length = bytes.readUInt32LE(entry + 8);
    const offset = bytes.readUInt32LE(entry + 12);
    if (length === 0 || offset < headerSize || offset > bytes.length - length) {
      return invalid();
    }
    // Below the target size prefer growth; once a frame covers the target prefer the tightest fit.
    const closer =
      !selected ||
      (selected.width < size
        ? width > selected.width
        : width >= size && width < selected.width);
    if (closer) {
      // RT_ICON bits passed to the shell must be DWORD-aligned, so copy the frame out of the directory offset.
      selected = {
        image: Buffer.from(bytes.subarray(offset, offset + length)),
        width,
      };
    }
  }
  return selected?.image ?? invalid();
}
