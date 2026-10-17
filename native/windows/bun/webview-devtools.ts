import { type Pointer, read, toArrayBuffer } from "bun:ffi";
import { type ComHandler, disposeHandlers, handler, method } from "./com.ts";
import { withWide } from "./win32-bindings.ts";

// Slot of ICoreWebView2::CallDevToolsProtocolMethod in the pinned WebView2 SDK 1.0.4129.50.
const CALL_DEVTOOLS_PROTOCOL_METHOD_SLOT = 36;
// ICoreWebView2CallDevToolsProtocolMethodCompletedHandler.
const COMPLETED_HANDLER_IID = "5c4889f0-5ef6-4c5a-952c-d8f1b92d0574";
// Bounds the UTF-16 scan of a result string; Runtime.evaluate results stay far below this.
const MAX_RESULT_CHARS = 1_048_576;

/** Result of one DevTools protocol call: the HRESULT and the JSON the browser returned. */
export type DevToolsProtocolResult = {
  hresult: number;
  json: string;
};

/** Read the NUL-terminated UTF-16 result that WebView2 lends only for the Invoke call. */
function readBorrowedWide(address: Pointer | null): string {
  if (!address) {
    return "";
  }
  let bytes = 0;
  while (bytes < 2 * MAX_RESULT_CHARS && read.u16(address, bytes)) {
    bytes += 2;
  }
  return Buffer.from(toArrayBuffer(address, 0, bytes)).toString("utf16le");
}

/**
 * Start a Chrome DevTools Protocol method on a WebView2 page.
 *
 * The call works with AreDevToolsEnabled off, because that setting only gates the browser UI.
 * `done` runs once from the message pump on the creating STA, so the caller must keep pumping.
 * The returned handler stays owned by the caller until `done` has run; retire it afterwards
 * with `disposeHandlers`. A failure to start the call throws and leaves nothing to retire.
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
      done({
        hresult: Number(hresult),
        json: readBorrowedWide(json as Pointer | null),
      });
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
    // Native never retained the handler, so its only reference is ours.
    disposeHandlers([
      completion,
    ]);
    throw new Error(
      `CallDevToolsProtocolMethod ${protocolMethod}: 0x${(result >>> 0).toString(16)}`,
    );
  }
  return completion;
}
