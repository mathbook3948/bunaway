import { z } from "zod";

/** Binary operations leave room for base64, path and envelope in a 1 MiB message. */
export const MAX_STORAGE_BYTES = 256 * 1024;
const MAX_BASE64_CHARACTERS = 4 * Math.ceil(MAX_STORAGE_BYTES / 3);
/** Canonical padded base64, including empty bytes, with a decoded size bound. */
export const storageBytesSchema = z
  .string()
  .max(MAX_BASE64_CHARACTERS)
  .regex(
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$(?![\s\S])/,
  )
  .refine((value) => {
    let padding = 0;
    if (value.endsWith("==")) {
      padding = 2;
    } else if (value.endsWith("=")) {
      padding = 1;
    }
    const size = (value.length / 4) * 3 - padding;
    if (size > MAX_STORAGE_BYTES) {
      return false;
    }
    if (!padding) {
      return true;
    }
    const alphabet =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const last = alphabet.indexOf(value[value.length - padding - 1] ?? "");
    return (last & (padding === 2 ? 15 : 3)) === 0;
  }, "Bytes must use canonical base64 within the decoded size limit.");
