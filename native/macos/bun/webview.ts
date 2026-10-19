import { type Pointer, ptr, toArrayBuffer } from "bun:ffi";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";
import { clampWindowSize } from "@bunaway/plugin-api/native";
import { BunawayError, type WireError } from "@bunaway/protocol";
import type { MacosApplication } from "./application.ts";
import type { MacosConfig } from "./config.ts";
import { Objc, type ObjcObject } from "./objc.ts";
import { macosOrigin, platformUrl, resourceRules } from "./urls.ts";
import { MacosWebviewControls } from "./webview-controls.ts";
import {
  MAX_LOAD_RETRIES,
  StalledLoadClock,
  WebviewDiagnostics,
  webviewError,
} from "./webview-diagnostics.ts";
import { nextViewIndex, probeWebview } from "./webview-probe.ts";

const NS_VIEW_WIDTH_SIZABLE = 2;
const NS_VIEW_HEIGHT_SIZABLE = 16;
const WK_USER_SCRIPT_INJECTION_AT_DOCUMENT_START = 0;
const WK_NAVIGATION_CANCEL = 0;
const WK_NAVIGATION_ALLOW = 1;
const WK_PERMISSION_DENY = 0;
const NS_URL_ERROR_CANCELLED = -999;
/** NSWindowSharingNone: other processes cannot read the window's contents. */
const NS_WINDOW_SHARING_NONE = 0;
/** NSWindowSharingReadOnly: the AppKit default, readable by capture and sharing. */
const NS_WINDOW_SHARING_READ_ONLY = 1;
/** WebKitErrorFrameLoadInterruptedByPolicyChange. */
const WEBKIT_ERROR_FRAME_LOAD_INTERRUPTED = 102;
const NS_UNBOUNDED_CONTENT_SIZE = 3.4028234663852886e38;
const BRIDGE = `(() => {
  const listeners = new Set();
  window.chrome = { webview: {
    postMessage: value => window.webkit.messageHandlers.bunaway.postMessage(value),
    addEventListener: (type, callback) => { if (type === 'message') listeners.add(callback); },
    removeEventListener: (type, callback) => { if (type === 'message') listeners.delete(callback); }
  }};
  window.__bunawayDeliver = text => {
    const data = JSON.parse(text);
    for (const callback of [...listeners]) { try { callback({data}); } catch {} }
  };
  // WKWebView can restore a cached JS heap after Back/Forward. Its SDK client was
  // permanently closed by pagehide, so load a fresh document in the same history entry.
  window.addEventListener('pageshow', event => {
    if (event.persisted && window === window.top) window.location.reload();
  });
})();`;
const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

/** The WKWebView of a window with the objects that belong to it alone, replaced as one unit. */
interface NativeView {
  webview: ObjcObject;
  controller: ObjcObject;
  configuration: ObjcObject;
  /** Owned by this view (alloc/init); released when the view is replaced or the window closes. */
  retained: ObjcObject[];
}

/**
 * Test-only switches. `windows.ts` never passes them, so a production window always loads for real
 * and reads the system clock.
 */
export interface WebviewTestHooks {
  /** Accept the load of this view generation as WebKit would during a stall: policy allowed, nothing follows. */
  stallLoad?(generation: number): boolean;
  /** Clock of the stall check, so a test spans the retry intervals without waiting for them. */
  now?(): number;
}

function required(value: ObjcObject | null): ObjcObject {
  if (!value) {
    throw new Error("AppKit object creation failed.");
  }
  return value;
}

// Registered Objective-C classes retain their IMPs for the entire process.
// Keep the owning JSCallback and framework handles alive even after the window closes.
const runtimeOwners: Objc[] = [];

/** Own a single AppKit window and WKWebView using only Bun FFI and system frameworks. */
export class MacosWebview {
  private readonly objc = new Objc();
  private readonly window: ObjcObject;
  /** The WKWebView in use; `recreateStalledView` replaces it once. */
  private view: NativeView;
  /** Counts the views built; a callback of an earlier view compares its own number with this one. */
  private generation = 1;
  /** Set once the single recreation was attempted, whatever its outcome. */
  private recreated = false;
  /** Window-level objects (window delegate, rule list), released by `close`. */
  private readonly retained: ObjcObject[] = [];
  private readonly diagnostics: WebviewDiagnostics;
  /** Compiled resource rules, added to every view's controller. */
  private ruleList: ObjcObject | null = null;
  /** Creation order and time of the current view and the callbacks it has seen, read by `probe`. */
  private viewIndex = nextViewIndex();
  private createdAt = Date.now();
  private policyCalls = 0;
  private assetStarts = 0;
  private lastNavigation: ObjcObject | null = null;
  private firstScriptMessage = false;
  private firstDelivery = false;
  private loadStartedAt = 0;
  private startupCheckpoint = 0;
  private closed = false;
  private rulesReady = false;
  private coreReady = false;
  private navigationStarted = false;
  /** The current load request reached `didStartProvisionalNavigation`; reset by every load request. */
  private provisionalSeen = false;
  /** Stall clock and retry budget of this view's load; the budget is reset by the reload after a WebContent crash and by the replacement view. */
  private loadClock = new StalledLoadClock();
  private provisionalNavigation: ObjcObject | null = null;
  /** Latest top-level document navigation; unlike provisionalNavigation it survives commit until completion. */
  private documentNavigation: ObjcObject | null = null;
  readonly controls: MacosWebviewControls;
  readonly ready: Promise<void>;

  constructor(
    private readonly config: Omit<MacosConfig, "windows" | "appMetadata"> & {
      window: import("@bunaway/plugin-api/native").WindowSpec;
    },
    readonly hooks: {
      receive(source: string, raw: string): void;
      revoke(reason: string): void;
      close(): void;
      /** The window became key; never called after close. */
      activated(): void;
      /** The current document navigation finished, or failed with the given outcome. */
      documentComplete(error: WireError | null): void;
      log(event: string, fields?: object): void;
      fail(error: unknown): void;
    },
    private readonly application: MacosApplication,
    /** Deterministic stalls and a clock for tests; production code never passes it. */
    private readonly testHooks?: WebviewTestHooks,
  ) {
    const o = this.objc;
    this.diagnostics = new WebviewDiagnostics(hooks.log);
    runtimeOwners.push(o);
    // Construction runs outside the application's tick pools (startup windows, `windows.recreate`).
    // Without its own pool, objects AppKit and WebKit autorelease here, including retains on the
    // window, are never freed, so a closed window stays in `[NSApp windows]`. Everything that must
    // outlive the constructor is owned (alloc/init, released in `close`), not autoreleased.
    const pool = o.object("NSAutoreleasePool");
    try {
      const windowDelegate = o.delegate([
        {
          selector: "windowShouldClose:",
          arguments: 1,
          returns: "bool",
          encoding: "B@:@",
          call: () => {
            if (!this.closed) {
              hooks.close();
            }
            return false;
          },
        },
        {
          // Records the most recently activated window for lastActive lookup.
          selector: "windowDidBecomeKey:",
          arguments: 1,
          encoding: "v@:@",
          call: () => {
            if (!this.closed) {
              hooks.activated();
            }
          },
        },
      ]);
      this.retained.push(windowDelegate);
      const size = config.window.window;
      const constraints = {
        minWidth: size.minWidth ?? null,
        minHeight: size.minHeight ?? null,
        maxWidth: size.maxWidth ?? null,
        maxHeight: size.maxHeight ?? null,
      };
      const initialSize = clampWindowSize(size.width, size.height, constraints);
      this.window = o.window(initialSize.width, initialSize.height);
      o.setSize(
        this.window,
        "setContentMinSize:",
        constraints.minWidth ?? 0,
        constraints.minHeight ?? 0,
      );
      o.setSize(
        this.window,
        "setContentMaxSize:",
        constraints.maxWidth ?? NS_UNBOUNDED_CONTENT_SIZE,
        constraints.maxHeight ?? NS_UNBOUNDED_CONTENT_SIZE,
      );
      o.send(this.window, "setTitle:", o.string(config.window.title));
      o.send(this.window, "setDelegate:", windowDelegate);
      // Protect before the window is first ordered in, so no frame is ever capturable.
      if (size.contentProtection === true) {
        this.setContentProtection(true);
      }
      this.view = this.buildView(initialSize, this.generation);
      o.send(
        o.send(this.window, "contentView"),
        "addSubview:",
        this.view.webview,
      );

      o.send(this.window, "center");
      // Hidden creation never orders front, takes key status or activates the app.
      if (config.window.visible !== false && !config.window.showWhenReady) {
        this.present();
      }
      const viewPolicy = config.policy.views.find(
        (view) => view.id === config.window.view,
      );
      if (!viewPolicy) {
        throw new Error("Missing view policy.");
      }
      this.controls = new MacosWebviewControls(
        o,
        () => {
          if (this.closed) {
            throw new BunawayError({
              code: "CANCELLED",
              message: "WebView is closed.",
            });
          }
          if (!this.rulesReady) {
            throw new BunawayError({
              code: "BUSY",
              message: "WebView is not ready.",
            });
          }
          return this.view.webview;
        },
        viewPolicy.origins,
        this.window,
        () => this.application.isActive(),
      );
      this.diagnostics.record("created");
      this.ready = new Promise<void>((resolveReady, reject) => {
        const completion = o.block(2, (_block, rules, error) => {
          if (this.closed) {
            reject(new Error("WebView closed during setup."));
            return;
          }
          if (!rules || error) {
            this.diagnostics.record("rules-failed", this.errorDetails(error));
            reject(new Error("WebKit resource-rule compilation failed."));
            return;
          }
          // The list is owned here so a replacement view gets the same rules.
          o.send(rules, "retain");
          this.retained.push(rules);
          this.ruleList = rules;
          o.send(this.view.controller, "addContentRuleList:", rules);
          this.rulesReady = true;
          this.diagnostics.record("rules-ready");
          hooks.log("webview-ready");
          this.navigateWhenReady();
          resolveReady();
        });
        o.send(
          o.send(o.class("WKContentRuleListStore"), "defaultStore"),
          "compileContentRuleListForIdentifier:encodedContentRuleList:completionHandler:",
          o.string(`bunaway-${config.runtime.id}-${config.window.view}`),
          o.string(resourceRules(viewPolicy.origins)),
          completion,
        );
      });
    } catch (error) {
      this.close();
      throw error;
    } finally {
      o.send(pool, "drain");
    }
  }

  /**
   * Create a WKWebView with everything that belongs to it alone: configuration, user content
   * controller, URL scheme handler, script message handler and navigation delegate. Every callback
   * checks its generation first, so a view that was replaced can no longer touch this window's
   * state; it only answers the decisions WebKit still waits for.
   */
  private buildView(
    size: {
      width: number;
      height: number;
    },
    generation: number,
  ): NativeView {
    const o = this.objc;
    const { hooks, config, application } = this;
    const retained: ObjcObject[] = [];
    const current = () => !this.closed && generation === this.generation;
    // Owned from creation on, so a failure while the rest is wired releases it.
    let created: ObjcObject | undefined;
    try {
      const configuration = o.object("WKWebViewConfiguration");
      const controller = o.object("WKUserContentController");
      retained.push(configuration, controller);
      const scheme = o.delegate([
        {
          selector: "webView:startURLSchemeTask:",
          arguments: 2,
          encoding: "v@:@@",
          call: (_self, _cmd, _view, task) => {
            if (task && current()) {
              this.serve(task);
            }
          },
        },
        {
          selector: "webView:stopURLSchemeTask:",
          arguments: 2,
          encoding: "v@:@@",
          call: () => {
            if (current()) {
              this.diagnostics.record("asset-stopped");
            }
          },
        },
      ]);
      retained.push(scheme);
      o.send(
        configuration,
        "setURLSchemeHandler:forURLScheme:",
        scheme,
        o.string("bunaway"),
      );
      const scriptHandler = o.delegate([
        {
          selector: "userContentController:didReceiveScriptMessage:",
          arguments: 2,
          encoding: "v@:@@",
          call: (_self, _cmd, _controller, message) => {
            if (!current() || !message) {
              return;
            }
            const frame = o.send(message, "frameInfo");
            if (!o.send(frame, "isMainFrame")) {
              hooks.log("frame-message-ignored");
              return;
            }
            // WKWebView supplies frame identity and its live URL; neither is trusted from JSON.
            const source = this.source();
            const frameSource = o.text(
              o.send(o.send(o.send(frame, "request"), "URL"), "absoluteString"),
            );
            // A provisional document has no usable route. In particular, an old frame cannot
            // acquire the destination's authority while WebKit is replacing the document.
            if (
              this.provisionalNavigation ||
              macosOrigin(frameSource) !== macosOrigin(source)
            ) {
              this.diagnostics.record(
                this.provisionalNavigation
                  ? "provisional-message-ignored"
                  : "origin-message-ignored",
              );
              hooks.log("frame-message-ignored");
              return;
            }
            const body = o.send(message, "body");
            // WebKit accepts NSDate and other values that would throw a native
            // exception during JSON serialization, before protocol validation.
            if (
              !o.send(
                o.class("NSJSONSerialization"),
                "isValidJSONObject:",
                body,
              )
            ) {
              hooks.log("web-message-rejected", {
                reason: "INVALID_ARGUMENT",
              });
              return;
            }
            const data = o.send(
              o.class("NSJSONSerialization"),
              "dataWithJSONObject:options:error:",
              body,
              0,
              null,
            );
            const bytes = o.send(data, "bytes");
            const length = Number(o.send(data, "length"));
            const raw = bytes
              ? Buffer.from(
                  toArrayBuffer(Number(bytes) as Pointer, 0, length),
                ).toString("utf8")
              : "";
            if (!this.firstScriptMessage) {
              this.firstScriptMessage = true;
              this.diagnostics.record("script-message");
            }
            hooks.receive(source, raw);
          },
        },
      ]);
      retained.push(scriptHandler);
      o.send(
        controller,
        "addScriptMessageHandler:name:",
        scriptHandler,
        o.string("bunaway"),
      );
      const script = required(
        o.send(
          o.send(o.class("WKUserScript"), "alloc"),
          "initWithSource:injectionTime:forMainFrameOnly:",
          o.string(BRIDGE),
          WK_USER_SCRIPT_INJECTION_AT_DOCUMENT_START,
          0,
        ),
      );
      retained.push(script);
      o.send(controller, "addUserScript:", script);
      o.send(configuration, "setUserContentController:", controller);
      o.send(
        configuration,
        "setWebsiteDataStore:",
        application.dataStore(config.window.view),
      );
      const webview = o.webview(size.width, size.height, configuration);
      created = webview;
      const cancelDownload = o.block(1, () => {});
      const navigation = o.delegate([
        {
          selector: "webView:decidePolicyForNavigationAction:decisionHandler:",
          arguments: 3,
          encoding: "v@:@@@?",
          call: (_self, _cmd, _view, action, decision) => {
            if (!current()) {
              // A superseded view still gets an answer; WebKit requires its decision handler to run once.
              o.decide(decision ?? null, WK_NAVIGATION_CANCEL);
              return;
            }
            let allowed = false;
            try {
              const target = o.text(
                o.send(
                  o.send(o.send(action ?? null, "request"), "URL"),
                  "absoluteString",
                ),
              );
              const frame = o.send(action ?? null, "targetFrame");
              const view = config.policy.views.find(
                (view) => view.id === config.window.view,
              );
              allowed =
                !!frame &&
                !!view?.origins.includes(macosOrigin(target)) &&
                !this.closed;
              if (allowed && o.send(frame, "isMainFrame")) {
                hooks.log("navigation", {
                  uri: target,
                });
              } else if (!allowed) {
                let event = "new-window-blocked";
                if (frame) {
                  event = o.send(frame, "isMainFrame")
                    ? "navigation-blocked"
                    : "web-resource-blocked";
                }
                hooks.log(event, {
                  uri: target,
                });
              }
            } catch (error) {
              hooks.fail(error);
            }
            this.policyCalls++;
            this.diagnostics.record("action-policy", {
              allowed,
            });
            o.decide(
              decision ?? null,
              allowed ? WK_NAVIGATION_ALLOW : WK_NAVIGATION_CANCEL,
            );
            if (allowed) {
              // The stall clock starts only once the policy decision is out, so a slow decision
              // is never mistaken for WebKit not starting the navigation.
              this.loadClock.policyAllowed(this.stallClockNow());
            }
            this.diagnostics.record("action-policy-returned", {
              allowed,
            });
          },
        },
        {
          selector:
            "webView:decidePolicyForNavigationResponse:decisionHandler:",
          arguments: 3,
          encoding: "v@:@@@?",
          call: (_self, _cmd, _view, response, decision) => {
            if (!current()) {
              // A superseded view still gets an answer; WebKit requires its decision handler to run once.
              o.decide(decision ?? null, WK_NAVIGATION_CANCEL);
              return;
            }
            let allowed = false;
            try {
              const target = o.text(
                o.send(
                  o.send(o.send(response ?? null, "response"), "URL"),
                  "absoluteString",
                ),
              );
              allowed =
                !this.closed &&
                !!config.policy.views
                  .find((view) => view.id === config.window.view)
                  ?.origins.includes(macosOrigin(target));
              if (!allowed) {
                hooks.log("navigation-response-blocked", {
                  uri: target,
                });
              }
            } catch (error) {
              hooks.fail(error);
            }
            this.diagnostics.record("response-policy", {
              allowed,
            });
            // WebKit need not issue a second action callback for server redirects.
            // Resource rules block denied requests; this final check also prevents document commit.
            o.decide(
              decision ?? null,
              allowed ? WK_NAVIGATION_ALLOW : WK_NAVIGATION_CANCEL,
            );
            this.diagnostics.record("response-policy-returned", {
              allowed,
            });
          },
        },
        {
          selector: "webView:didStartProvisionalNavigation:",
          arguments: 2,
          encoding: "v@:@@",
          call: (_self, _cmd, _view, navigation) => {
            if (current()) {
              this.provisionalSeen = true;
              this.diagnostics.record("provisional");
              this.provisionalNavigation = navigation ?? null;
              this.documentNavigation = navigation ?? null;
              // This callback marks a new document. Fragment/history-state changes retain their session.
              hooks.revoke("navigation");
            }
          },
        },
        {
          selector: "webView:didCommitNavigation:",
          arguments: 2,
          encoding: "v@:@@",
          call: (_self, _cmd, _view, navigation) => {
            if (!current()) {
              return;
            }
            this.diagnostics.record("committed");
            if (navigation === this.provisionalNavigation) {
              this.provisionalNavigation = null;
            }
          },
        },
        ...[
          "webView:didFailProvisionalNavigation:withError:",
          "webView:didFailNavigation:withError:",
        ].map((selector) => ({
          selector,
          arguments: 3,
          encoding: "v@:@@@",
          call: (
            _self: Pointer | null,
            _cmd: Pointer | null,
            _view: Pointer | null,
            navigation: Pointer | null,
            error: Pointer | null,
          ) => {
            if (!current()) {
              return;
            }
            this.diagnostics.record(
              selector === "webView:didFailProvisionalNavigation:withError:"
                ? "provisional-failed"
                : "navigation-failed",
              this.errorDetails(error),
            );
            if (navigation === this.provisionalNavigation) {
              this.provisionalNavigation = null;
            }
            hooks.log("navigation-completed", {
              success: false,
              source: this.source(),
            });
            if (
              !this.closed &&
              navigation &&
              navigation === this.documentNavigation
            ) {
              this.documentNavigation = null;
              hooks.documentComplete({
                code: this.isCancelledNavigation(error)
                  ? "CANCELLED"
                  : "INTERNAL",
                message: "Document navigation did not complete.",
              });
            }
          },
        })),
        {
          selector: "webView:navigationAction:didBecomeDownload:",
          arguments: 3,
          encoding: "v@:@@@",
          call: (_self, _cmd, _view, _action, download) => {
            if (download) {
              o.send(download, "cancel:", cancelDownload);
            }
          },
        },
        {
          selector: "webView:didFinishNavigation:",
          arguments: 2,
          encoding: "v@:@@",
          call: (_self, _cmd, _view, navigation) => {
            if (!current()) {
              return;
            }
            this.diagnostics.record("finished");
            hooks.log("navigation-completed", {
              success: true,
              source: this.source(),
            });
            if (!this.closed && navigation === this.documentNavigation) {
              this.documentNavigation = null;
              hooks.documentComplete(null);
            }
          },
        },
        {
          selector: "webViewWebContentProcessDidTerminate:",
          arguments: 1,
          encoding: "v@:@",
          call: () => {
            // A superseded view's process ending says nothing about the view in use.
            if (generation !== this.generation) {
              return;
            }
            // After close the window and view are released; only the record remains.
            this.diagnostics.record(
              "process-terminated",
              this.closed
                ? {}
                : {
                    probe: this.probe(),
                  },
            );
            hooks.log("webview-process-failed", {
              kind: 1,
            });
            hooks.revoke("process-failed");
            if (!this.closed) {
              // The navigation that was running died with the process; a cancellation reported for
              // it later (for example by the `stopLoading` before a reissue) must not fail the
              // document of the reload.
              this.documentNavigation = null;
              this.provisionalNavigation = null;
              // A reload after a crash gets its own stall budget.
              this.loadClock.resetBudget();
              this.loadHome();
            }
          },
        },
        {
          selector:
            "webView:requestMediaCapturePermissionForOrigin:initiatedByFrame:type:decisionHandler:",
          arguments: 5,
          encoding: "v@:@@@q@?",
          call: (_self, _cmd, _view, _origin, _frame, _type, decision) => {
            hooks.log("permission-request-denied");
            o.decide(decision ?? null, WK_PERMISSION_DENY);
          },
        },
      ]);
      retained.push(navigation);
      o.send(webview, "setNavigationDelegate:", navigation);
      // Media permissions belong to WKUIDelegate, even when one object owns both contracts.
      o.send(webview, "setUIDelegate:", navigation);
      o.send(
        webview,
        "setAutoresizingMask:",
        NS_VIEW_WIDTH_SIZABLE | NS_VIEW_HEIGHT_SIZABLE,
      );
      return {
        webview,
        controller,
        configuration,
        retained,
      };
    } catch (error) {
      if (created) {
        o.send(created, "release");
      }
      for (const object of retained.reverse()) {
        o.send(object, "release");
      }
      throw error;
    }
  }

  source(): string {
    const o = this.objc;
    return o.withAutoreleasePool(() =>
      o.text(o.send(o.send(this.view.webview, "URL"), "absoluteString")),
    );
  }
  start(): void {
    this.coreReady = true;
    this.navigateWhenReady();
  }
  /** Initial display: order front, take key status and activate the app. */
  present(): void {
    this.objc.withAutoreleasePool(() => {
      this.objc.send(this.window, "makeKeyAndOrderFront:", null);
      this.application.activate();
    });
  }
  /**
   * Show without activating the app or changing the key window. AppKit mapping:
   * `orderFront:` (not `makeKeyAndOrderFront:`) orders the window in without key status,
   * and a miniaturized window is left in the Dock so minimized state is preserved.
   */
  showInactive(): void {
    const o = this.objc;
    o.withAutoreleasePool(() => {
      // Like SW_SHOWNA, an already visible or miniaturized window keeps its z-order.
      if (o.send(this.window, "isMiniaturized") || this.isVisible()) {
        return;
      }
      o.send(this.window, "orderFront:", null);
      if (!this.isVisible()) {
        throw new Error("AppKit declined window visibility.");
      }
    });
  }
  show(visible: boolean): void {
    const o = this.objc;
    o.withAutoreleasePool(() => {
      o.send(
        this.window,
        visible ? "makeKeyAndOrderFront:" : "orderOut:",
        null,
      );
      if (this.isVisible() !== visible) {
        throw new Error("AppKit declined window visibility.");
      }
    });
  }
  focus(): boolean {
    const o = this.objc;
    return o.withAutoreleasePool(() => {
      if (o.send(this.window, "isMiniaturized")) {
        o.send(this.window, "deminiaturize:", null);
      }
      this.show(true);
      this.application.activate();
      return this.isFocused();
    });
  }
  isVisible(): boolean {
    return !!this.objc.send(this.window, "isVisible");
  }
  /**
   * Miniaturize into the Dock. The Dock animation finishes after the call returns, so
   * `isMinimized` can lag briefly. An already miniaturized window is left as it is.
   */
  minimize(): void {
    const o = this.objc;
    o.withAutoreleasePool(() => {
      if (!o.send(this.window, "isMiniaturized")) {
        o.send(this.window, "miniaturize:", null);
      }
    });
  }
  /**
   * Zoom to the standard frame, the AppKit meaning of maximize (the window does not enter native
   * fullscreen). A miniaturized window is restored first, and a window that is already zoomed stays.
   */
  maximize(): void {
    this.setZoomed(true);
  }
  /** Leave the miniaturized and the zoomed state, ending at the user frame. */
  unmaximize(): void {
    this.setZoomed(false);
  }
  /** Undo a miniaturize if there is one, otherwise a zoom. */
  restore(): void {
    const o = this.objc;
    o.withAutoreleasePool(() => {
      if (o.send(this.window, "isMiniaturized")) {
        o.send(this.window, "deminiaturize:", null);
      } else if (o.send(this.window, "isZoomed")) {
        o.send(this.window, "zoom:", null);
      }
    });
  }
  toggleMaximize(): void {
    this.setZoomed(!this.isMaximized());
  }
  isMinimized(): boolean {
    return !!this.objc.send(this.window, "isMiniaturized");
  }
  isMaximized(): boolean {
    return !!this.objc.send(this.window, "isZoomed");
  }
  /** `zoom:` toggles, so it is sent only when the state differs from the requested one. */
  private setZoomed(zoomed: boolean): void {
    const o = this.objc;
    o.withAutoreleasePool(() => {
      if (o.send(this.window, "isMiniaturized")) {
        o.send(this.window, "deminiaturize:", null);
      }
      if (!!o.send(this.window, "isZoomed") !== zoomed) {
        o.send(this.window, "zoom:", null);
      }
    });
  }
  /**
   * Exclude the window from screenshots and screen sharing through NSWindow.sharingType.
   * On macOS 15 and later, ScreenCaptureKit based capture may ignore sharingType,
   * so protection is best effort there.
   */
  setContentProtection(enabled: boolean): void {
    const o = this.objc;
    o.withAutoreleasePool(() => {
      o.send(
        this.window,
        "setSharingType:",
        enabled ? NS_WINDOW_SHARING_NONE : NS_WINDOW_SHARING_READ_ONLY,
      );
    });
  }
  /** Read the live NSWindow.sharingType, which is the source of truth for protection. */
  isContentProtected(): boolean {
    return (
      Number(this.objc.integer(this.window, "sharingType")) ===
      NS_WINDOW_SHARING_NONE
    );
  }
  isFocused(): boolean {
    return (
      !!this.objc.send(this.window, "isKeyWindow") &&
      this.application.isActive()
    );
  }
  private navigateWhenReady(): void {
    if (
      !this.closed &&
      this.rulesReady &&
      this.coreReady &&
      !this.navigationStarted
    ) {
      this.navigationStarted = true;
      this.loadHome();
    }
  }
  private loadHome(): void {
    if (!this.loadStartedAt) {
      this.loadStartedAt = Date.now();
    }
    this.diagnostics.record("load-requested");
    this.provisionalSeen = false;
    this.loadClock.requested();
    const o = this.objc;
    o.withAutoreleasePool(() => {
      const url = o.send(
        o.class("NSURL"),
        "URLWithString:",
        o.string(platformUrl(this.config.window.home)),
      );
      // A test can stall this load the way WebKit does: the policy decision is out, nothing follows.
      const stalled = this.testHooks?.stallLoad?.(this.generation) === true;
      if (stalled) {
        this.loadClock.policyAllowed(this.stallClockNow());
      }
      const navigation = stalled
        ? null
        : o.send(
            this.view.webview,
            "loadRequest:",
            o.send(o.class("NSURLRequest"), "requestWithURL:", url),
          );
      this.diagnostics.record("load-returned", {
        accepted: !!navigation,
        sameNavigation:
          !!navigation &&
          !!this.lastNavigation &&
          navigation === this.lastNavigation,
        probe: this.probe(),
      });
      this.lastNavigation = navigation;
    });
  }
  private errorDetails(error: ObjcObject | null) {
    return error
      ? webviewError(
          this.objc.text(this.objc.send(error, "domain")),
          this.objc.integer(error, "code"),
        )
      : {};
  }
  /** Cancellation by a newer load or a policy change is not a document failure. */
  private isCancelledNavigation(error: ObjcObject | null): boolean {
    if (!error) {
      return false;
    }
    const domain = this.objc.text(this.objc.send(error, "domain"));
    const code = Number(this.objc.integer(error, "code"));
    return (
      (domain === "NSURLErrorDomain" && code === NS_URL_ERROR_CANCELLED) ||
      (domain === "WebKitErrorDomain" &&
        code === WEBKIT_ERROR_FRAME_LOAD_INTERRUPTED)
    );
  }
  /**
   * WebKit can accept a load request and never start the provisional navigation (the policy
   * callback returns, then nothing follows). Cancel the pending load and reissue the request,
   * which restarts the navigation, a bounded number of times; the document and SDK deadlines are unchanged.
   */
  private retryStalledLoad(): void {
    if (this.closed || !this.navigationStarted || this.provisionalSeen) {
      return;
    }
    const action = this.loadClock.check(this.stallClockNow());
    if (action === "wait" || action === "none") {
      return;
    }
    if (action === "report") {
      if (!this.recreated && this.recreateStalledView()) {
        return;
      }
      this.diagnostics.record("load-stalled", {
        probe: this.probe(),
      });
      this.hooks.log("webview-load-stalled", {
        retries: MAX_LOAD_RETRIES,
      });
      return;
    }
    this.diagnostics.record("load-retried", {
      progress: this.objc.double(this.view.webview, "estimatedProgress"),
      probe: this.probe(),
    });
    // A load that WebKit accepted but never started can leave the view in a loading state that a
    // second `loadRequest:` does not leave. Cancelling it first gives the reissue a clean start; the
    // cancellation of a navigation that never began is not a document failure (see the fail
    // callbacks, which only complete the navigation they saw start).
    this.objc.withAutoreleasePool(() => {
      this.objc.send(this.view.webview, "stopLoading");
    });
    this.diagnostics.record("load-stopped");
    // The reissued load may never reach the policy callback, so `check` already restarted the
    // stall clock and `requested` keeps it instead of waiting for a decision.
    this.loadHome();
  }
  private stallClockNow(): number {
    return this.testHooks?.now?.() ?? Date.now();
  }
  /**
   * Reissuing the load to a view whose WebContent never starts the navigation does not help, but a
   * new WKWebView gets a new WebContent process. Before the stall is reported, replace the view once
   * with one built the same way (see `buildView`), put it in the same place in the window and load
   * the home page again with a fresh retry budget. Only the stalled view is replaced and only once:
   * a replacement that stalls too is reported like any other stall, and the document and SDK
   * deadlines are unchanged. Returns false, leaving the old view in place, when no replacement could
   * be built.
   */
  private recreateStalledView(): boolean {
    this.recreated = true;
    const o = this.objc;
    return o.withAutoreleasePool(() => {
      const previous = this.view;
      const generation = this.generation + 1;
      const stalledProbe = this.probe();
      let next: NativeView;
      try {
        next = this.buildView(this.viewSize(previous.webview), generation);
      } catch (error) {
        this.hooks.log("webview-recreate-failed", {
          reason: error instanceof Error ? error.message : String(error),
        });
        return false;
      }
      // From here a callback of the previous view finds a newer generation and does nothing.
      this.generation = generation;
      const hadFocus =
        o.send(this.window, "firstResponder") === previous.webview;
      this.detachView(previous);
      this.releaseView(previous);
      this.view = next;
      if (this.ruleList) {
        o.send(next.controller, "addContentRuleList:", this.ruleList);
      }
      o.send(o.send(this.window, "contentView"), "addSubview:", next.webview);
      if (hadFocus) {
        o.send(this.window, "makeFirstResponder:", next.webview);
      }
      // The new view starts its own record: index, age, callback counts, navigation state, budget.
      this.viewIndex = nextViewIndex();
      this.createdAt = Date.now();
      this.policyCalls = 0;
      this.assetStarts = 0;
      this.lastNavigation = null;
      this.provisionalNavigation = null;
      this.documentNavigation = null;
      // The replacement may never reach the policy callback either, so its clock starts now.
      this.loadClock = new StalledLoadClock();
      this.loadClock.startNow(this.stallClockNow());
      this.diagnostics.record("view-recreated", {
        probe: stalledProbe,
      });
      this.loadHome();
      return true;
    });
  }
  /** Width and height of a view's frame; KVC boxes the NSRect so no struct return is needed. */
  private viewSize(webview: ObjcObject): {
    width: number;
    height: number;
  } {
    const o = this.objc;
    const bytes = Buffer.alloc(4 * 8);
    o.send(
      o.send(webview, "valueForKey:", o.string("frame")),
      "getValue:size:",
      ptr(bytes),
      bytes.length,
    );
    return {
      width: bytes.readDoubleLE(16),
      height: bytes.readDoubleLE(24),
    };
  }
  /**
   * Detach a view from the window and WebKit: no callback reaches this object afterwards, and the
   * handler name and scripts are free again. The objects it owns are released by `releaseView`.
   */
  private detachView(view: NativeView): void {
    const o = this.objc;
    o.send(
      view.controller,
      "removeScriptMessageHandlerForName:",
      o.string("bunaway"),
    );
    o.send(view.controller, "removeAllUserScripts");
    o.send(view.webview, "stopLoading");
    o.send(view.webview, "setNavigationDelegate:", null);
    o.send(view.webview, "setUIDelegate:", null);
    o.send(view.webview, "removeFromSuperview");
    o.send(view.webview, "release");
  }
  private releaseView(view: NativeView): void {
    for (const object of view.retained.reverse()) {
      this.objc.send(object, "release");
    }
    view.retained.length = 0;
  }
  /**
   * Called every window scan tick. Reissues a stalled load (see `retryStalledLoad`, so the retry
   * interval is the stall threshold plus one tick), then observes a stalled initial bridge at
   * 5, 10 and 15 seconds; the checkpoints never change a deadline.
   */
  observeStartup(): void {
    this.retryStalledLoad();
    if (
      this.closed ||
      this.firstScriptMessage ||
      !this.loadStartedAt ||
      this.startupCheckpoint >= 3 ||
      Date.now() - this.loadStartedAt < (this.startupCheckpoint + 1) * 5000
    ) {
      return;
    }
    this.startupCheckpoint++;
    this.diagnostics.record("startup-checkpoint", {
      loading: !!this.objc.send(this.view.webview, "isLoading"),
      provisional: !!this.provisionalNavigation,
      progress: this.objc.double(this.view.webview, "estimatedProgress"),
      probe: this.probe(),
    });
  }
  /** Read-only snapshot of this view for the stalled-load log records; a failed read never affects the load. */
  private probe() {
    try {
      return probeWebview({
        o: this.objc,
        webview: this.view.webview,
        window: this.window,
        configuration: this.view.configuration,
        index: this.viewIndex,
        createdAt: this.createdAt,
        policyCalls: this.policyCalls,
        assetStarts: this.assetStarts,
      });
    } catch (error) {
      this.hooks.log("webview-probe-failed", {
        reason: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }
  deliver(text: string): void {
    if (this.closed) {
      return;
    }
    // Observe only the first delivery. A completion block per response would retain
    // callbacks for the entire process and distort the workload being diagnosed.
    let completion: Pointer | null = null;
    if (!this.firstDelivery) {
      this.firstDelivery = true;
      completion = this.objc.block(2, (_block, _result, error) => {
        if (!this.closed) {
          this.diagnostics.record("delivery-completed", {
            accepted: !error,
            ...this.errorDetails(error),
          });
        }
      });
    }
    // Worker messages arrive outside the native run-loop turn's autorelease pool.
    this.objc.withAutoreleasePool(() =>
      this.objc.send(
        this.view.webview,
        "evaluateJavaScript:completionHandler:",
        this.objc.string(`__bunawayDeliver(${JSON.stringify(text)})`),
        completion,
      ),
    );
  }
  private serve(task: Pointer): void {
    this.assetStarts++;
    this.diagnostics.record("asset-started");
    const o = this.objc;
    const url = o.send(o.send(task, "request"), "URL");
    let status = 403;
    let bytes: Buffer | undefined;
    let mime = "text/plain";
    try {
      const parsed = new URL(o.text(o.send(url, "absoluteString")));
      const view = this.config.policy.views.find(
        (view) => view.id === this.config.window.view,
      );
      const path = decodeURIComponent(
        parsed.pathname === "/" ? "/index.html" : parsed.pathname,
      );
      if (
        parsed.protocol !== "bunaway:" ||
        !view?.origins.includes(macosOrigin(parsed.href)) ||
        path
          .split("/")
          .some(
            (part) =>
              part === ".." ||
              part === "." ||
              part.includes("\\") ||
              part.includes("\0"),
          )
      ) {
        throw new Error("Invalid asset request.");
      }
      const root = realpathSync(resolve(this.config.assets, "web"));
      const file = realpathSync(resolve(root, `.${path}`));
      if (!file.startsWith(`${root}/`) || !statSync(file).isFile()) {
        throw new Error("Asset escapes web directory.");
      }
      bytes = readFileSync(file);
      mime = MIME[extname(file)] ?? "application/octet-stream";
      status = 200;
    } catch {
      /* Denied and missing assets both fail closed. */
    }
    const headers = o.send(
      o.class("NSDictionary"),
      "dictionaryWithObject:forKey:",
      o.string(mime),
      o.string("Content-Type"),
    );
    const response = o.send(
      o.send(o.class("NSHTTPURLResponse"), "alloc"),
      "initWithURL:statusCode:HTTPVersion:headerFields:",
      url,
      status,
      o.string("HTTP/1.1"),
      headers,
    );
    o.send(task, "didReceiveResponse:", response);
    if (bytes?.length) {
      o.send(
        task,
        "didReceiveData:",
        o.send(
          o.class("NSData"),
          "dataWithBytes:length:",
          ptr(bytes),
          bytes.length,
        ),
      );
    }
    o.send(task, "didFinish");
    this.diagnostics.record("asset-finished", {
      status,
    });
    o.send(response, "release");
  }
  /** Detach native delegates before releasing objects. Safe after repeated shutdown requests. */
  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.diagnostics.record("closed");
    const o = this.objc;
    // Absent when the first view could not be built.
    if (this.view) {
      this.detachView(this.view);
    }
    if (this.window) {
      o.send(this.window, "setDelegate:", null);
      o.send(this.window, "close");
      o.send(this.window, "release");
    }
    if (this.view) {
      this.releaseView(this.view);
    }
    for (const object of this.retained.reverse()) {
      o.send(object, "release");
    }
    this.retained.length = 0;
    o.releaseCallbacks();
  }
}
