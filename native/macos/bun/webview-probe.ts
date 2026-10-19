import type { Objc, ObjcObject } from "./objc.ts";

/** NSWindowOcclusionStateVisible. */
const NS_WINDOW_OCCLUSION_VISIBLE = 2n;

/** Views created by this process, in creation order; the first one is the view that has stalled in CI. */
let viewsCreated = 0;

export function nextViewIndex(): number {
  return ++viewsCreated;
}

/** State of one view, read only when a load stalls or is reissued. Values never include page content. */
export interface WebviewProbe {
  viewIndex: number;
  sinceViewMs: number;
  sinceProcessMs: number;
  contentPid: number | null;
  pool: string;
  store: string;
  loading: boolean;
  progress: number;
  hasUrl: boolean;
  windowVisible: boolean;
  windowOccluded: boolean;
  viewHidden: boolean;
  policyCalls: number;
  assetStarts: number;
}

export interface ProbeSource {
  o: Objc;
  webview: ObjcObject;
  window: ObjcObject;
  configuration: ObjcObject;
  index: number;
  createdAt: number;
  policyCalls: number;
  assetStarts: number;
}

function hex(value: ObjcObject | null): string {
  return value ? BigInt(value).toString(16) : "0";
}

/** BOOL and pid_t come back in the low bits of a register; the upper bits are not defined. */
function low(value: number | bigint, bits: bigint): bigint {
  return BigInt(value) & ((1n << bits) - 1n);
}

function flag(o: Objc, object: ObjcObject, name: string): boolean {
  return low(o.integer(object, name), 8n) !== 0n;
}

/**
 * Snapshot for the stalled-load investigation. `_webProcessIdentifier` is a private WebKit
 * property, so it is read only when the view answers it and is `null` otherwise.
 */
export function probeWebview(source: ProbeSource): WebviewProbe {
  const { o, webview, window, configuration } = source;
  const answers = o.send(
    webview,
    "respondsToSelector:",
    o.selector("_webProcessIdentifier"),
  );
  return {
    viewIndex: source.index,
    sinceViewMs: Date.now() - source.createdAt,
    sinceProcessMs: Math.round(process.uptime() * 1000),
    contentPid:
      answers && low(BigInt(answers), 8n) !== 0n
        ? Number(low(o.integer(webview, "_webProcessIdentifier"), 32n))
        : null,
    pool: hex(o.send(configuration, "processPool")),
    store: hex(o.send(configuration, "websiteDataStore")),
    loading: flag(o, webview, "isLoading"),
    progress: o.double(webview, "estimatedProgress"),
    hasUrl: !!o.send(webview, "URL"),
    windowVisible: flag(o, window, "isVisible"),
    windowOccluded:
      (low(o.integer(window, "occlusionState"), 64n) &
        NS_WINDOW_OCCLUSION_VISIBLE) ===
      0n,
    viewHidden: flag(o, webview, "isHiddenOrHasHiddenAncestor"),
    policyCalls: source.policyCalls,
    assetStarts: source.assetStarts,
  };
}
