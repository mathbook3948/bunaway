import { BunawayError } from "@bunaway/protocol";
import {
  type ClipboardImage,
  type ClipboardItem,
  filesSchema,
  imageSchema,
  MAX_FILES,
  MAX_IMAGE_BYTES,
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
  MAX_IMAGE_BYTES + DIB_HEADER_BYTES + 4096 * 4,
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
  if (
    ![
      40,
      108,
      124,
    ].includes(header) ||
    header > bytes.length ||
    width < 1 ||
    width > 4096 ||
    height < 1 ||
    height > 4096 ||
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
  let offset = header;
  let alpha = false;
  if (compression === BI_BITFIELDS) {
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
      offset += 12;
    } else {
      const mask = bytes.readUInt32LE(52);
      if (mask !== 0 && mask !== 0xff000000) {
        invalidClipboardData();
      }
      alpha = mask !== 0;
    }
  }
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
  }
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
