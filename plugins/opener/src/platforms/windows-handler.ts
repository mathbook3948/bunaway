import { dlopen, type FFIFunction } from "bun:ffi";
import { wide, withBuffer } from "@bunaway/plugin/win32";
import { BunawayError } from "@bunaway/protocol";

/** Longest text accepted from the Shell, in UTF-16 code units including the NUL. */
export const MAX_HANDLER_TEXT_UNITS = 32768;
const ASSOCF_IS_PROTOCOL = 0x1000;
const ASSOCSTR_EXECUTABLE = 2;
const ASSOCSTR_FRIENDLYAPPNAME = 4;
const HRESULT_NO_ASSOCIATION = 0x80070483;
const HRESULT_MORE_DATA = 0x800700ea;
const HRESULT_POINTER = 0x80004003;
const CHARACTER_BYTES = 2;
// The size reported by a length query can change before the second call; one retry covers that.
const MAX_QUERY_ATTEMPTS = 2;

const SHLWAPI = {
  AssocQueryStringW: {
    args: [
      "u32",
      "u32",
      "ptr",
      "ptr",
      "ptr",
      "ptr",
    ],
    returns: "i32",
  },
} as const satisfies Record<string, FFIFunction>;

/** The application the Shell associates with a URL scheme. */
export type UrlHandler = {
  name: string;
  path: string;
};

function failed(reason: string): BunawayError {
  return new BunawayError({
    code: "INTERNAL",
    message: `Windows could not report the URL handler: ${reason}.`,
  });
}

/**
 * Bind `AssocQueryStringW` for the life of the opener. The query is read-only: it reads
 * the registered protocol association and never starts the application.
 */
export function createUrlHandlerQuery() {
  const shlwapi = dlopen("shlwapi.dll", SHLWAPI);
  let disposed = false;

  /** Call `AssocQueryStringW` with a UINT in-out size and an optional output buffer. */
  function call(
    association: Buffer,
    kind: number,
    output: Buffer | null,
    units: number,
  ): {
    result: number;
    units: number;
  } {
    const size = new Uint32Array([
      units,
    ]);
    const result = withBuffer(association, (assoc) =>
      withBuffer(Buffer.from(size.buffer), (sizeAddress) =>
        output === null
          ? shlwapi.symbols.AssocQueryStringW(
              ASSOCF_IS_PROTOCOL,
              kind,
              assoc,
              null,
              null,
              sizeAddress,
            )
          : withBuffer(output, (outputAddress) =>
              shlwapi.symbols.AssocQueryStringW(
                ASSOCF_IS_PROTOCOL,
                kind,
                assoc,
                null,
                outputAddress,
                sizeAddress,
              ),
            ),
      ),
    );
    return {
      result,
      units: size[0] ?? 0,
    };
  }

  /**
   * Read one association string for a scheme. A length query with a NULL buffer reports
   * the needed size, then the text is read into a buffer of exactly that size. Returns
   * null when the scheme has no association.
   */
  function queryString(scheme: string, kind: number): string | null {
    const association = wide(scheme);
    for (let attempt = 0; attempt < MAX_QUERY_ATTEMPTS; attempt++) {
      const sized = call(association, kind, null, 0);
      if (sized.result >>> 0 === HRESULT_NO_ASSOCIATION) {
        return null;
      }
      if (
        sized.result < 0 ||
        sized.units === 0 ||
        sized.units > MAX_HANDLER_TEXT_UNITS
      ) {
        throw failed("size query failed");
      }
      const output = Buffer.alloc(sized.units * CHARACTER_BYTES);
      const read = call(association, kind, output, sized.units);
      const code = read.result >>> 0;
      if (code === HRESULT_NO_ASSOCIATION) {
        return null;
      }
      if (code === HRESULT_MORE_DATA || code === HRESULT_POINTER) {
        continue;
      }
      if (read.result < 0) {
        throw failed("query failed");
      }
      const text = output.toString("utf16le").split("\0", 1)[0] ?? "";
      // Callers display and compare this text, so control characters are not passed on.
      if (text === "" || /\p{Cc}/u.test(text)) {
        throw failed("invalid text");
      }
      return text;
    }
    throw failed("size kept changing");
  }

  return {
    /**
     * Look up the display name and executable path registered for a URL scheme such as
     * `https`. Returns null when no application is associated. Other failures throw
     * `INTERNAL`. Calls after disposal throw `CANCELLED`.
     */
    query(scheme: string): UrlHandler | null {
      if (disposed) {
        throw new BunawayError({
          code: "CANCELLED",
          message: "Opener has been disposed.",
        });
      }
      const name = queryString(scheme, ASSOCSTR_FRIENDLYAPPNAME);
      if (name === null) {
        return null;
      }
      const path = queryString(scheme, ASSOCSTR_EXECUTABLE);
      return path === null
        ? null
        : {
            name,
            path,
          };
    },
    /** Unload shlwapi after the opener's last query. Repeated calls are safe. */
    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      shlwapi.close();
    },
  };
}
