import { dlopen, type FFIFunction } from "bun:ffi";
import { wide, withBuffer } from "@bunaway/plugin/win32";
import type { UrlHandler } from "#opener/contract";
import { BunawayError } from "@bunaway/protocol";
import {
  type AssociationCall,
  readAssociationString,
  resolveUrlHandler,
} from "#opener/platforms/windows-handler-query";

const ASSOCF_IS_PROTOCOL = 0x1000;
const ASSOCSTR_EXECUTABLE = 2;
const ASSOCSTR_FRIENDLYAPPNAME = 4;

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

/**
 * Bind `AssocQueryStringW` for the life of the opener. The query is read-only: it reads
 * the registered protocol association and never starts the application.
 */
export function createUrlHandlerQuery() {
  const shlwapi = dlopen("shlwapi.dll", SHLWAPI);
  let disposed = false;

  /** Bind one scheme and association kind to a raw `AssocQueryStringW` call. */
  function associationCall(scheme: string, kind: number): AssociationCall {
    const association = wide(scheme);
    return (output, units) => {
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
    };
  }

  return {
    /**
     * Look up the display name and executable path registered for a URL scheme such as
     * `https`. Returns null when no usable application is found, whatever the reason, as
     * Electron does. Calls after disposal throw `CANCELLED`.
     */
    query(scheme: string): UrlHandler | null {
      if (disposed) {
        throw new BunawayError({
          code: "CANCELLED",
          message: "Opener has been disposed.",
        });
      }
      return resolveUrlHandler(
        () =>
          readAssociationString(
            associationCall(scheme, ASSOCSTR_FRIENDLYAPPNAME),
          ),
        () =>
          readAssociationString(associationCall(scheme, ASSOCSTR_EXECUTABLE)),
      );
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
