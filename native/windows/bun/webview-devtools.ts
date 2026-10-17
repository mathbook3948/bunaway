import { dlopen, type Pointer, toArrayBuffer } from "bun:ffi";
import { hresultText, withWide } from "@bunaway/plugin/win32";
import { type ComHandler, handler, method } from "./com.ts";

// Slot of ICoreWebView2::CallDevToolsProtocolMethod in the pinned WebView2 SDK 1.0.4129.50.
const CALL_DEVTOOLS_PROTOCOL_METHOD_SLOT = 36;
// ICoreWebView2CallDevToolsProtocolMethodCompletedHandler.
const COMPLETED_HANDLER_IID = "5c4889f0-5ef6-4c5a-952c-d8f1b92d0574";
// Longest result accepted; Runtime.evaluate replies for the host's own scripts stay far below this.
const MAX_RESULT_CHARS = 1_048_576;

/** Result of one DevTools protocol call: the HRESULT and the JSON the browser returned. */
export type DevToolsProtocolResult = {
  hresult: number;
  json: string;
};

// E_OUTOFMEMORY, reported when a result exceeds MAX_RESULT_CHARS instead of returning it truncated.
const RESULT_TOO_LARGE_HRESULT = -2147024882;
const text = dlopen("kernel32.dll", {
  lstrlenW: {
    args: [
      "ptr",
    ],
    returns: "i32",
  },
});

/**
 * Read the NUL-terminated UTF-16 result that WebView2 lends only for the Invoke call.
 * Returns null when it is longer than MAX_RESULT_CHARS.
 */
function readBorrowedWide(address: Pointer | null): string | null {
  if (!address) {
    return "";
  }
  const chars = text.symbols.lstrlenW(address);
  if (chars > MAX_RESULT_CHARS) {
    return null;
  }
  return Buffer.from(toArrayBuffer(address, 0, chars * 2)).toString("utf16le");
}

/**
 * Start a Chrome DevTools Protocol method on a WebView2 page.
 *
 * The call works with AreDevToolsEnabled off, because that setting only gates the browser UI.
 * `done` runs once from the message pump on the creating STA, so the caller must keep pumping.
 * The returned handler stays owned by the caller until `done` has run; retire it afterwards
 * with `disposeHandlers`. A failure to start the call throws `DevToolsStartError`, which carries
 * the never-started handler for the caller to retire outside any COM callback.
 */
export function callDevToolsProtocolMethod(
  webview: Pointer,
  protocolMethod: string,
  parametersJson: string,
  done: (result: DevToolsProtocolResult) => void,
): ComHandler {
  const completion = handler(
    `devtools-${protocolMethod}`,
    COMPLETED_HANDLER_IID,
    [
      "i32",
      "ptr",
    ],
    (hresult, json) => {
      const body = readBorrowedWide(json as Pointer | null);
      done(
        body === null
          ? {
              hresult: RESULT_TOO_LARGE_HRESULT,
              json: "",
            }
          : {
              hresult: Number(hresult),
              json: body,
            },
      );
    },
  );
  const result = withWide(protocolMethod, (name) =>
    withWide(parametersJson, (parameters) =>
      method(webview, CALL_DEVTOOLS_PROTOCOL_METHOD_SLOT, [
        "ptr",
        "ptr",
        "ptr",
      ])(name, parameters, completion.pointer),
    ),
  );
  if (result < 0) {
    // Native never retained the handler, so its only reference is the owner's. It is handed
    // back instead of disposed here, because this call may run inside another COM callback
    // where disposal is not allowed.
    throw new DevToolsStartError(protocolMethod, result, completion);
  }
  return completion;
}

/** A DevTools protocol call that native refused to start; `completion` is still owned by the caller. */
export class DevToolsStartError extends Error {
  constructor(
    readonly protocolMethod: string,
    readonly hresult: number,
    readonly completion: ComHandler,
  ) {
    super(
      `CallDevToolsProtocolMethod ${protocolMethod}: ${hresultText(hresult)}`,
    );
    this.name = "DevToolsStartError";
  }
}
