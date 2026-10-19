import { BunawayError } from "@bunaway/protocol";
import {
  bookmarkSchema,
  type ClipboardImage,
  type ClipboardItem,
  filesSchema,
  imageSchema,
  MAX_BINARY_BYTES,
  MAX_BOOKMARK_LENGTH,
  MAX_FILES,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_DIMENSION,
  MAX_PATH_LENGTH,
  MAX_TEXT_LENGTH,
  rtfSchema,
  textSchema,
} from "#clipboard/contract";

const DIB_HEADER_BYTES = 124;
const BI_RGB = 0;
const BI_BITFIELDS = 3;
const LCS_SRGB = 0x73524742;
export const MAX_NATIVE_FORMAT_BYTES = Math.max(
  MAX_IMAGE_BYTES + DIB_HEADER_BYTES + MAX_IMAGE_DIMENSION * 4,
  MAX_FILES * (MAX_PATH_LENGTH + 1) * 2 + 22,
);

/** Reject malformed or unsupported external data rather than silently truncating it. */
export function invalidClipboardData(): never {
  throw new BunawayError({
    code: "INTERNAL",
    message: "Windows clipboard data is invalid or exceeds supported limits.",
  });
}

/** Encode a top-down sRGB DIBV5 with explicit RGBA channel masks. Windows owns the copied HGLOBAL. */
export function encodeImage(image: ClipboardImage): Buffer {
  const rgba = Buffer.from(image.rgba, "base64");
  const result = Buffer.alloc(DIB_HEADER_BYTES + rgba.length);
  result.writeUInt32LE(DIB_HEADER_BYTES, 0);
  result.writeInt32LE(image.width, 4);
  result.writeInt32LE(-image.height, 8);
  result.writeUInt16LE(1, 12);
  result.writeUInt16LE(32, 14);
  result.writeUInt32LE(BI_BITFIELDS, 16);
  result.writeUInt32LE(rgba.length, 20);
  result.writeUInt32LE(0x00ff0000, 40);
  result.writeUInt32LE(0x0000ff00, 44);
  result.writeUInt32LE(0x000000ff, 48);
  result.writeUInt32LE(0xff000000, 52);
  result.writeUInt32LE(LCS_SRGB, 56);
  result.writeUInt32LE(4, 108); // LCS_GM_IMAGES
  for (let index = 0; index < rgba.length; index += 4) {
    result[DIB_HEADER_BYTES + index] = rgba[index + 2] ?? 0;
    result[DIB_HEADER_BYTES + index + 1] = rgba[index + 1] ?? 0;
    result[DIB_HEADER_BYTES + index + 2] = rgba[index] ?? 0;
    result[DIB_HEADER_BYTES + index + 3] = rgba[index + 3] ?? 0;
  }
  return result;
}

/** Reject DIB headers whose size, dimensions, plane count, depth or compression this transport cannot decode. */
function assertSupportedDibHeader(
  bytes: Buffer,
  header: number,
  width: number,
  height: number,
  bits: number,
  compression: number,
): void {
  if (
    ![
      40,
      108,
      124,
    ].includes(header) ||
    header > bytes.length ||
    width < 1 ||
    width > MAX_IMAGE_DIMENSION ||
    height < 1 ||
    height > MAX_IMAGE_DIMENSION ||
    width * height * 4 > MAX_IMAGE_BYTES ||
    bytes.readUInt16LE(12) !== 1 ||
    ![
      24,
      32,
    ].includes(bits) ||
    bytes.readUInt32LE(32) !== 0 ||
    (compression !== BI_RGB && compression !== BI_BITFIELDS)
  ) {
    invalidClipboardData();
  }
}

/**
 * Validate BI_BITFIELDS masks, which must be the standard BGRA layout. A 40-byte header stores the
 * three color masks after the header (`extraOffset`); V4 and V5 headers embed them and may add an
 * alpha mask.
 */
function readBitfields(
  bytes: Buffer,
  header: number,
  bits: number,
): {
  extraOffset: number;
  alpha: boolean;
} {
  if (bits !== 32 || (header === 40 && bytes.length < 52)) {
    invalidClipboardData();
  }
  const masks = 40;
  if (
    bytes.readUInt32LE(masks) !== 0x00ff0000 ||
    bytes.readUInt32LE(masks + 4) !== 0x0000ff00 ||
    bytes.readUInt32LE(masks + 8) !== 0x000000ff
  ) {
    invalidClipboardData();
  }
  if (header === 40) {
    return {
      extraOffset: 12,
      alpha: false,
    };
  }
  const mask = bytes.readUInt32LE(52);
  if (mask !== 0 && mask !== 0xff000000) {
    invalidClipboardData();
  }
  return {
    extraOffset: 0,
    alpha: mask !== 0,
  };
}

/** Reject V4 and V5 headers that ask for color conversion or an embedded profile. */
function assertNoColorTransform(bytes: Buffer, header: number): void {
  if (header >= 108) {
    const colorSpace = bytes.readUInt32LE(56);
    // Zero-filled calibrated headers are common legacy data. Nonzero endpoints
    // or gamma require color conversion, which this pixel transport does not perform.
    if (
      colorSpace !== LCS_SRGB &&
      (colorSpace !== 0 || bytes.subarray(60, 108).some((byte) => byte !== 0))
    ) {
      invalidClipboardData();
    }
  }
  if (
    header === 124 &&
    (bytes.readUInt32LE(112) !== 0 || bytes.readUInt32LE(116) !== 0)
  ) {
    invalidClipboardData();
  }
}

/** Decode bounded 24/32-bit BI_RGB or standard BGRA masks. V5 profiles and other encodings are rejected. */
export function decodeImage(bytes: Buffer): ClipboardImage {
  if (bytes.length < 40) {
    invalidClipboardData();
  }
  const header = bytes.readUInt32LE(0);
  const width = bytes.readInt32LE(4);
  const signedHeight = bytes.readInt32LE(8);
  const height = Math.abs(signedHeight);
  const bits = bytes.readUInt16LE(14);
  const compression = bytes.readUInt32LE(16);
  assertSupportedDibHeader(bytes, header, width, height, bits, compression);
  let offset = header;
  let alpha = false;
  if (compression === BI_BITFIELDS) {
    const bitfields = readBitfields(bytes, header, bits);
    offset += bitfields.extraOffset;
    alpha = bitfields.alpha;
  }
  assertNoColorTransform(bytes, header);
  const stride = Math.ceil((width * bits) / 32) * 4;
  if (offset + stride * height > bytes.length) {
    invalidClipboardData();
  }
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const row = signedHeight < 0 ? y : height - y - 1;
    for (let x = 0; x < width; x++) {
      const source = offset + row * stride + x * (bits / 8);
      const target = (y * width + x) * 4;
      rgba[target] = bytes[source + 2] ?? 0;
      rgba[target + 1] = bytes[source + 1] ?? 0;
      rgba[target + 2] = bytes[source] ?? 0;
      rgba[target + 3] = alpha ? (bytes[source + 3] ?? 0) : 255;
    }
  }
  return imageSchema.parse({
    width,
    height,
    rgba: rgba.toString("base64"),
  });
}

/** CF_HTML offsets count UTF-8 bytes, including the ASCII header. */
export function encodeHTML(fragment: string): Buffer {
  const prefix = "<html><body><!--StartFragment-->";
  const suffix = "<!--EndFragment--></body></html>";
  const template =
    "Version:1.0\r\nStartHTML:0000000000\r\nEndHTML:0000000000\r\nStartFragment:0000000000\r\nEndFragment:0000000000\r\n";
  const start = Buffer.byteLength(template);
  const startFragment = start + Buffer.byteLength(prefix);
  const endFragment = startFragment + Buffer.byteLength(fragment);
  const end = endFragment + Buffer.byteLength(suffix);
  const offsets: Record<string, number> = {
    StartHTML: start,
    EndHTML: end,
    StartFragment: startFragment,
    EndFragment: endFragment,
  };
  const header = template.replace(
    /(StartHTML|EndHTML|StartFragment|EndFragment):0{10}/g,
    (_match, key: string) => `${key}:${String(offsets[key]).padStart(10, "0")}`,
  );
  return Buffer.from(`${header}${prefix}${fragment}${suffix}\0`, "utf8");
}

export function decodeHTML(bytes: Buffer): string {
  const header = bytes.subarray(0, 1024).toString("ascii");
  const start = /^StartFragment:[ \t]*(\d+)[ \t]*\r?$/m.exec(header);
  const end = /^EndFragment:[ \t]*(\d+)[ \t]*\r?$/m.exec(header);
  if (!start || !end) {
    invalidClipboardData();
  }
  const from = Number(start[1]);
  const to = Number(end[1]);
  if (
    !Number.isSafeInteger(from) ||
    !Number.isSafeInteger(to) ||
    from < Math.max(start.index + start[0].length, end.index + end[0].length) ||
    to < from ||
    to > bytes.length ||
    to - from > MAX_TEXT_LENGTH * 4
  ) {
    invalidClipboardData();
  }
  try {
    return textSchema.parse(
      new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(bytes.subarray(from, to)),
    );
  } catch {
    return invalidClipboardData();
  }
}

export function encodeFiles(files: string[]): Buffer {
  const paths = Buffer.from(`${files.join("\0")}\0\0`, "utf16le");
  const result = Buffer.alloc(20 + paths.length);
  result.writeUInt32LE(20, 0); // DROPFILES.pFiles
  result.writeUInt32LE(1, 16); // DROPFILES.fWide
  paths.copy(result, 20);
  return result;
}

export function decodeFiles(bytes: Buffer): string[] {
  if (bytes.length < 24 || bytes.readUInt32LE(16) !== 1) {
    invalidClipboardData();
  }
  const offset = bytes.readUInt32LE(0);
  if (offset < 20 || offset % 2 !== 0 || offset + 4 > bytes.length) {
    invalidClipboardData();
  }
  const files: string[] = [];
  let start = offset;
  for (let position = offset; position + 1 < bytes.length; position += 2) {
    if (bytes.readUInt16LE(position) !== 0) {
      continue;
    }
    if (position === start) {
      try {
        return filesSchema.parse(files);
      } catch {
        return invalidClipboardData();
      }
    }
    if (files.length >= MAX_FILES || (position - start) / 2 > MAX_PATH_LENGTH) {
      invalidClipboardData();
    }
    files.push(bytes.subarray(start, position).toString("utf16le"));
    start = position + 2;
  }
  return invalidClipboardData();
}

/** Prepare all formats before replacing the clipboard. */
export function encodeItem(item: ClipboardItem): Buffer {
  switch (item.format) {
    case "text/plain":
      return Buffer.from(`${item.data}\0`, "utf16le");
    case "text/html":
      return encodeHTML(item.data);
    case "text/rtf":
      return Buffer.from(`${item.data}\0`, "ascii");
    case "application/x-bunaway-file-list":
      return encodeFiles(item.data);
    case "image/bmp":
      return encodeImage(item.data);
    case "application/x-bunaway-bookmark":
      return Buffer.from(`${item.data.url}\0`, "utf16le");
    default:
      return encodeBinary(item.data);
  }
}

const BINARY_MAGIC = Buffer.from("BUNBIN01", "ascii");
const BINARY_HEADER_BYTES = BINARY_MAGIC.length + 4;

/** A versioned length prefix preserves empty bytes and excludes HGLOBAL allocation padding. */
export function encodeBinary(base64: string): Buffer {
  const payload = Buffer.from(base64, "base64");
  const bytes = Buffer.alloc(BINARY_HEADER_BYTES + payload.length);
  BINARY_MAGIC.copy(bytes);
  bytes.writeUInt32LE(payload.length, BINARY_MAGIC.length);
  payload.copy(bytes, BINARY_HEADER_BYTES);
  return bytes;
}

/** Copy only the declared payload; trailing allocator bytes never become application data. */
export function decodeBinary(bytes: Buffer): string {
  if (
    bytes.length < BINARY_HEADER_BYTES ||
    bytes.length > MAX_NATIVE_FORMAT_BYTES ||
    !bytes.subarray(0, BINARY_MAGIC.length).equals(BINARY_MAGIC)
  ) {
    invalidClipboardData();
  }
  const length = bytes.readUInt32LE(BINARY_MAGIC.length);
  if (
    length > MAX_BINARY_BYTES ||
    BINARY_HEADER_BYTES + length > bytes.length
  ) {
    invalidClipboardData();
  }
  return bytes
    .subarray(BINARY_HEADER_BYTES, BINARY_HEADER_BYTES + length)
    .toString("base64");
}

/** CFSTR_INETURLW contains one NUL-terminated UTF-16 URL without a title. */
export function decodeBookmark(bytes: Buffer): {
  url: string;
} {
  if (
    bytes.length < 2 ||
    bytes.length > MAX_NATIVE_FORMAT_BYTES ||
    bytes.length % 2 !== 0
  ) {
    invalidClipboardData();
  }
  let end = 0;
  while (end < bytes.length && bytes.readUInt16LE(end) !== 0) {
    end += 2;
  }
  if (end === bytes.length || end / 2 > MAX_BOOKMARK_LENGTH) {
    invalidClipboardData();
  }
  const result = bookmarkSchema.safeParse({
    url: bytes.subarray(0, end).toString("utf16le"),
  });
  return result.success ? result.data : invalidClipboardData();
}
export function decodeRTF(bytes: Buffer): string {
  const end = bytes.indexOf(0);
  if (
    end < 0 ||
    end > MAX_TEXT_LENGTH ||
    bytes.subarray(0, end).some((byte) => byte > 127)
  ) {
    invalidClipboardData();
  }
  try {
    return rtfSchema.parse(bytes.subarray(0, end).toString("ascii"));
  } catch {
    return invalidClipboardData();
  }
}
