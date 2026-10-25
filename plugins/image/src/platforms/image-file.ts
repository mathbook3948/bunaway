import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { BunawayError, isRecord } from "@bunaway/protocol";
import { type ImageMime, MAX_SOURCE_FILE_BYTES } from "#image/contract";

/** Opening a FIFO or device without O_NONBLOCK can wait forever; the type check follows the open. */
const NONBLOCK = constants.O_NONBLOCK ?? 0;
const EXTENDED_PREFIX = "\\\\?\\";
const PNG_SIGNATURE = Buffer.from([
  137,
  80,
  78,
  71,
  13,
  10,
  26,
  10,
]);
const JPEG_SIGNATURE = Buffer.from([
  0xff,
  0xd8,
  0xff,
]);
const BMP_SIGNATURE = Buffer.from("BM", "ascii");

function failure(
  code: ConstructorParameters<typeof BunawayError>[0]["code"],
  message: string,
  cause?: unknown,
): BunawayError {
  const error = new BunawayError({
    code,
    message,
  });
  error.cause = cause;
  return error;
}

/** Map an open or read error to the public contract without exposing the path. */
function fileError(error: unknown): unknown {
  if (error instanceof BunawayError) {
    return error;
  }
  const code = isRecord(error) ? error.code : undefined;
  switch (code) {
    case "ENOENT":
    case "ENOTDIR":
      return failure("INVALID_ARGUMENT", "Image file not found.", error);
    case "EISDIR":
    case "ENXIO":
      return failure("INVALID_ARGUMENT", "Image path is not a file.", error);
    case "ENAMETOOLONG":
      return failure("INVALID_ARGUMENT", "Image path is too long.", error);
    case "EACCES":
    case "EPERM":
    case "EBUSY":
    case "ELOOP":
      return failure("PERMISSION_DENIED", "Image file access denied.", error);
    default:
      return error;
  }
}

/** Identify the encoding from the file's leading bytes; the extension is never trusted. */
export function sniffImageMime(bytes: Buffer): ImageMime | undefined {
  if (bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    return "image/png";
  }
  if (bytes.subarray(0, JPEG_SIGNATURE.length).equals(JPEG_SIGNATURE)) {
    return "image/jpeg";
  }
  if (bytes.subarray(0, BMP_SIGNATURE.length).equals(BMP_SIGNATURE)) {
    return "image/bmp";
  }
  return undefined;
}

/**
 * Read an image file whose path the schema already checked. The size limit applies to the opened
 * descriptor, so the file cannot grow past it between the check and the read, and only a regular
 * file is read. Links are followed, as for the other path-taking plugins. Fails with
 * INVALID_ARGUMENT for a missing file, a directory, a file over the size limit or an
 * unrecognized encoding.
 */
export function readImageFile(path: string): {
  bytes: Buffer;
  mime: ImageMime;
} {
  const fileSystemPath = `${EXTENDED_PREFIX}${path.replaceAll("/", "\\")}`;
  let descriptor: number;
  try {
    descriptor = openSync(fileSystemPath, constants.O_RDONLY | NONBLOCK);
  } catch (error) {
    throw fileError(error);
  }
  try {
    const info = fstatSync(descriptor);
    if (!info.isFile()) {
      throw failure("INVALID_ARGUMENT", "Image path is not a file.");
    }
    if (info.size > MAX_SOURCE_FILE_BYTES) {
      throw failure("INVALID_ARGUMENT", "Image file is too large.");
    }
    const bytes = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(
        descriptor,
        bytes,
        offset,
        bytes.length - offset,
        null,
      );
      if (count === 0) {
        throw failure("INVALID_ARGUMENT", "Image file changed during read.");
      }
      offset += count;
    }
    const mime = sniffImageMime(bytes);
    if (!mime) {
      throw failure("INVALID_ARGUMENT", "Image file format is not supported.");
    }
    return {
      bytes,
      mime,
    };
  } catch (error) {
    throw fileError(error);
  } finally {
    closeSync(descriptor);
  }
}
