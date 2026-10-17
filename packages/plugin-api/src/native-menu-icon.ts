import { MAX_TRAY_ICO_BYTES } from "./native-tray.ts";

/** One image stored in an ICO directory: a PNG or an uncompressed DIB without the file header. */
export type NativeMenuIcoFrame = {
  width: number;
  height: number;
  image: Buffer;
};

const ICO_HEADER_BYTES = 6;
const ICO_ENTRY_BYTES = 16;
const MAX_ICO_FRAMES = 32;
/** A directory entry stores 0 for a 256 pixel dimension. */
const ICO_LARGE_DIMENSION = 256;

/**
 * Split a canonical base64 ICO into its frames, bounding the decoded size and checking every
 * directory entry. Returns undefined for anything else. Image contents are validated by Windows
 * when the frame is converted, because only it can tell whether a PNG or DIB decodes.
 */
export function parseNativeMenuIco(
  ico: string,
): NativeMenuIcoFrame[] | undefined {
  if (ico.length > Math.ceil(MAX_TRAY_ICO_BYTES / 3) * 4) {
    return undefined;
  }
  const bytes = Buffer.from(ico, "base64");
  if (
    bytes.length < ICO_HEADER_BYTES + ICO_ENTRY_BYTES ||
    bytes.length > MAX_TRAY_ICO_BYTES ||
    bytes.toString("base64") !== ico ||
    bytes.readUInt16LE(0) !== 0 ||
    bytes.readUInt16LE(2) !== 1
  ) {
    return undefined;
  }
  const count = bytes.readUInt16LE(4);
  const directoryBytes = ICO_HEADER_BYTES + count * ICO_ENTRY_BYTES;
  if (count < 1 || count > MAX_ICO_FRAMES || bytes.length < directoryBytes) {
    return undefined;
  }
  const frames: NativeMenuIcoFrame[] = [];
  for (let index = 0; index < count; index++) {
    const entry = ICO_HEADER_BYTES + index * ICO_ENTRY_BYTES;
    const size = bytes.readUInt32LE(entry + 8);
    const offset = bytes.readUInt32LE(entry + 12);
    if (
      bytes.readUInt8(entry + 3) !== 0 ||
      size === 0 ||
      offset < directoryBytes ||
      offset > bytes.length - size
    ) {
      return undefined;
    }
    frames.push({
      width: bytes.readUInt8(entry) || ICO_LARGE_DIMENSION,
      height: bytes.readUInt8(entry + 1) || ICO_LARGE_DIMENSION,
      image: bytes.subarray(offset, offset + size),
    });
  }
  return frames;
}

/** Prefer the smallest frame that covers `size` so scaling only shrinks, else the largest. */
export function selectNativeMenuIcoFrame(
  frames: readonly NativeMenuIcoFrame[],
  size: number,
): NativeMenuIcoFrame | undefined {
  let covering: NativeMenuIcoFrame | undefined;
  let largest: NativeMenuIcoFrame | undefined;
  for (const frame of frames) {
    const extent = Math.max(frame.width, frame.height);
    if (
      extent >= size &&
      (!covering || extent < Math.max(covering.width, covering.height))
    ) {
      covering = frame;
    }
    if (!largest || extent > Math.max(largest.width, largest.height)) {
      largest = frame;
    }
  }
  return covering ?? largest;
}
