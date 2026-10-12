import { type Pointer, ptr } from "bun:ffi";
import type { WebViewDownload } from "@bunaway/plugin-api/native";
import { BunawayError } from "@bunaway/protocol";
import {
  addRef,
  type ComHandler,
  getObject,
  getString,
  handler,
  method,
  query,
  release,
} from "./com.ts";
import { type DownloadResource, Downloads } from "./downloads.ts";
import { hr } from "./win32-bindings.ts";

/** Read WebView2's INT64 byte counts without silently losing integer precision. */
function bytes(object: Pointer, slot: 12 | 13): number | null {
  const value = new BigInt64Array(1);
  hr(
    method(object, slot, [
      "ptr",
    ])(ptr(value)),
    "Read download byte count",
  );
  const count = value[0] ?? -1n;
  return count >= 0n && count <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(count)
    : null;
}

function integer(object: Pointer, slot: 16 | 17 | 21): number {
  const value = new Int32Array(1);
  hr(
    method(object, slot, [
      "ptr",
    ])(ptr(value)),
    "Read download state",
  );
  return value[0] ?? 0;
}

function downloadState(value: number): WebViewDownload["state"] {
  switch (value) {
    case 0:
      return "inProgress";
    case 1:
      return "interrupted";
    case 2:
      return "completed";
    default:
      throw new BunawayError({
        code: "INTERNAL",
        message: "Unknown WebView2 download state.",
      });
  }
}

/** Retain a start deferral until one decision, then own its operation through terminal cleanup. */
function resource(args: Pointer): DownloadResource {
  // Reject first, including failures while acquiring the operation or its metadata.
  hr(
    method(args, 5, [
      "i32",
    ])(1),
    "Hold download approval",
  );
  const operation = getObject(args, 3);
  let deferral: Pointer | undefined;
  try {
    deferral = getObject(args, 10);
  } catch (error) {
    release(operation);
    throw error;
  }
  addRef(args);
  let pendingArgs: Pointer | undefined = args;
  let disposed = false;
  const decide = (allow: boolean) => {
    if (!pendingArgs || !deferral) {
      return;
    }
    const currentArgs = pendingArgs;
    const currentDeferral = deferral;
    pendingArgs = undefined;
    deferral = undefined;
    try {
      hr(
        method(currentArgs, 5, [
          "i32",
        ])(allow ? 0 : 1),
        "Decide download",
      );
    } finally {
      try {
        hr(method(currentDeferral, 3, [])(), "Complete download deferral");
      } finally {
        release(currentDeferral);
        release(currentArgs);
      }
    }
  };
  return {
    read() {
      const nativeState = integer(operation, 16);
      const state = pendingArgs ? "pending" : downloadState(nativeState);
      return {
        url: getString(operation, 9),
        contentDisposition: getString(operation, 10),
        mimeType: getString(operation, 11),
        path: pendingArgs
          ? getString(pendingArgs, 6)
          : getString(operation, 15),
        totalBytes: bytes(operation, 12),
        receivedBytes: bytes(operation, 13),
        state,
        interruptReason:
          state === "interrupted" ? integer(operation, 17) : null,
        canResume: !pendingArgs && integer(operation, 21) !== 0,
      };
    },
    decide,
    cancel: () => {
      hr(method(operation, 18, [])(), "Cancel download");
    },
    pause: () => {
      hr(method(operation, 19, [])(), "Pause download");
    },
    resume: () => {
      hr(method(operation, 20, [])(), "Resume download");
    },
    dispose(browserGone = false) {
      if (disposed) {
        return;
      }
      disposed = true;
      try {
        if (browserGone) {
          // The old broker no longer accepts operations. These are owned COM references only.
          if (deferral) {
            release(deferral);
          }
          if (pendingArgs) {
            release(pendingArgs);
          }
          deferral = undefined;
          pendingArgs = undefined;
        } else {
          decide(false);
        }
      } finally {
        release(operation);
      }
    },
  };
}

/** Own the ICoreWebView2_4 subscription and bounded download approval state on the UI STA. */
export class WebViewDownloads {
  readonly operations: Downloads;
  readonly callback: ComHandler;
  private readonly webview4: Pointer;
  private readonly token: bigint;
  private detached = false;

  constructor(
    webview: Pointer,
    allowed: (url: string, source: string) => boolean,
    retain: (callback: ComHandler) => void,
    private readonly active: () => boolean,
    onFailure: (error: unknown) => void,
    onDenied: (url: string) => void,
  ) {
    this.operations = new Downloads(allowed, undefined, onFailure, onDenied);
    this.webview4 = query(webview, "20d02d59-6df2-42dc-bd06-f98a694b1302");
    this.callback = handler(
      "download-starting",
      "efedc989-c396-41ca-83f7-07f845a55724",
      [
        "ptr",
        "ptr",
      ],
      (_sender, args) => {
        if (this.detached || !this.active()) {
          hr(
            method(args as Pointer, 5, [
              "i32",
            ])(1),
            "Cancel closing download",
          );
          return;
        }
        const pending = resource(args as Pointer);
        try {
          this.operations.offer(pending, getString(webview, 4));
        } catch (error) {
          pending.dispose();
          throw error;
        }
      },
    );
    retain(this.callback);
    const token = new BigInt64Array(1);
    try {
      hr(
        method(this.webview4, 75, [
          "ptr",
          "ptr",
        ])(this.callback.pointer, ptr(token)),
        "add_DownloadStarting",
      );
      this.token = token[0] ?? 0n;
    } catch (error) {
      release(this.webview4);
      throw error;
    }
  }

  /** Remove native interest and retire operations; callback disposal waits for the owning WebView drain. */
  detach(browserGone = false): void {
    if (this.detached) {
      return;
    }
    this.detached = true;
    try {
      const result = method(this.webview4, 76, [
        "i64",
      ])(this.token);
      // HRESULT_FROM_WIN32(ERROR_INVALID_STATE) is expected only after observed broker failure.
      const HRESULT_INVALID_STATE = -2147019873;
      if (!browserGone || result !== HRESULT_INVALID_STATE) {
        hr(result, "remove_DownloadStarting");
      }
    } finally {
      try {
        this.operations.dispose(browserGone);
      } finally {
        release(this.webview4);
      }
    }
  }
}
