import type { UrlHandler } from "#opener/contract";

/** Longest text accepted from the Shell, in UTF-16 code units including the NUL. */
export const MAX_HANDLER_TEXT_UNITS = 32768;
const HRESULT_MORE_DATA = 0x800700ea;
const HRESULT_POINTER = 0x80004003;
const CHARACTER_BYTES = 2;
// The size reported by a length query can change before the second call; one retry covers that.
const MAX_QUERY_ATTEMPTS = 2;

/**
 * One `AssocQueryStringW` call with an in-out size in UTF-16 units. A null `output` asks for
 * the needed size only. `result` is the raw signed HRESULT.
 */
export type AssociationCall = (
  output: Buffer | null,
  units: number,
) => {
  result: number;
  units: number;
};

/**
 * Read one association string. A length query reports the needed size, then the text is
 * read into a buffer of exactly that size, retrying once when the size changed in between.
 *
 * Like Chromium and Electron, any failed HRESULT, an empty or oversized result and text
 * with control characters all mean there is no usable handler, so none of them is told
 * apart from a missing association and the result is null.
 */
export function readAssociationString(call: AssociationCall): string | null {
  for (let attempt = 0; attempt < MAX_QUERY_ATTEMPTS; attempt++) {
    const sized = call(null, 0);
    if (
      sized.result < 0 ||
      sized.units === 0 ||
      sized.units > MAX_HANDLER_TEXT_UNITS
    ) {
      return null;
    }
    const output = Buffer.alloc(sized.units * CHARACTER_BYTES);
    const read = call(output, sized.units);
    const code = read.result >>> 0;
    if (code === HRESULT_MORE_DATA || code === HRESULT_POINTER) {
      continue;
    }
    if (read.result < 0) {
      return null;
    }
    const text = output.toString("utf16le").split("\0", 1)[0] ?? "";
    // Callers display and compare this text, so control characters are not passed on.
    return text === "" || /\p{Cc}/u.test(text) ? null : text;
  }
  return null;
}

/** Combine the display name and executable path lookups; either one missing means no handler. */
export function resolveUrlHandler(
  readName: () => string | null,
  readPath: () => string | null,
): UrlHandler | null {
  const name = readName();
  if (name === null) {
    return null;
  }
  const path = readPath();
  return path === null
    ? null
    : {
        name,
        path,
      };
}
