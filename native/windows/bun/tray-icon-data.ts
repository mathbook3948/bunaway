import { MAX_TRAY_ICO_BYTES } from "@bunaway/plugin-api/native";
import { BunawayError } from "@bunaway/protocol";

function invalid(): never {
  throw new BunawayError({
    code: "INVALID_ARGUMENT",
    message: "Invalid tray ICO image.",
  });
}
/** Decode a bounded canonical ICO and select its highest-resolution frame without file I/O. */
export function trayIconImage(ico: string): Buffer {
  if (ico.length > Math.ceil(MAX_TRAY_ICO_BYTES / 3) * 4) {
    return invalid();
  }
  const bytes = Buffer.from(ico, "base64");
  if (
    bytes.length < 22 ||
    bytes.length > MAX_TRAY_ICO_BYTES ||
    bytes.toString("base64") !== ico ||
    bytes.readUInt16LE(0) !== 0 ||
    bytes.readUInt16LE(2) !== 1
  ) {
    return invalid();
  }
  const count = bytes.readUInt16LE(4);
  const headerSize = 6 + count * 16;
  if (count < 1 || count > 32 || bytes.length < headerSize) {
    return invalid();
  }
  let selected: Buffer | undefined;
  let largest = 0;
  for (let index = 0; index < count; index++) {
    const entry = 6 + index * 16;
    const width = bytes.readUInt8(entry) || 256;
    const height = bytes.readUInt8(entry + 1) || 256;
    const size = bytes.readUInt32LE(entry + 8);
    const offset = bytes.readUInt32LE(entry + 12);
    if (
      bytes.readUInt8(entry + 3) !== 0 ||
      size === 0 ||
      offset < headerSize ||
      offset > bytes.length - size
    ) {
      return invalid();
    }
    const area = width * height;
    if (area > largest) {
      const image = bytes.subarray(offset, offset + size);
      validateImage(image, width, height);
      selected = image;
      largest = area;
    }
  }
  return selected ?? invalid();
}

/** Limit decoded allocation and require a complete PNG or conventional uncompressed ICO DIB. */
function validateImage(image: Buffer, width: number, height: number): void {
  const png = Buffer.from([
    137,
    80,
    78,
    71,
    13,
    10,
    26,
    10,
  ]);
  if (image.length >= 33 && image.subarray(0, 8).equals(png)) {
    if (
      image.readUInt32BE(8) !== 13 ||
      image.toString("ascii", 12, 16) !== "IHDR" ||
      image.readUInt32BE(16) !== width ||
      image.readUInt32BE(20) !== height
    ) {
      invalid();
    }
    let offset = 8;
    let ended = false;
    while (offset <= image.length - 12) {
      const length = image.readUInt32BE(offset);
      if (length > image.length - offset - 12) {
        invalid();
      }
      const type = image.toString("ascii", offset + 4, offset + 8);
      offset += length + 12;
      if (type === "IEND") {
        ended = length === 0 && offset === image.length;
        break;
      }
    }
    if (!ended) {
      invalid();
    }
    return;
  }
  if (
    image.length < 40 ||
    image.readUInt32LE(0) !== 40 ||
    image.readInt32LE(4) !== width ||
    image.readInt32LE(8) !== height * 2 ||
    image.readUInt16LE(12) !== 1 ||
    image.readUInt32LE(16) !== 0
  ) {
    invalid();
  }
  const bits = image.readUInt16LE(14);
  if (
    ![
      1,
      4,
      8,
      16,
      24,
      32,
    ].includes(bits)
  ) {
    invalid();
  }
  const declaredColors = image.readUInt32LE(32);
  const colors = bits <= 8 ? declaredColors || 2 ** bits : 0;
  if ((bits <= 8 && colors > 2 ** bits) || (bits > 8 && declaredColors !== 0)) {
    invalid();
  }
  const colorBytes = Math.ceil((width * bits) / 32) * 4 * height;
  const declaredBytes = image.readUInt32LE(20);
  if (declaredBytes !== 0 && declaredBytes !== colorBytes) {
    invalid();
  }
  const maskBytes = Math.ceil(width / 32) * 4 * height;
  if (image.length < 40 + colors * 4 + colorBytes + maskBytes) {
    invalid();
  }
}
