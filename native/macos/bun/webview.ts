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
import { WebviewDiagnostics, webviewError } from "./webview-diagnostics.ts";

const NS_VIEW_WIDTH_SIZABLE = 2;
const NS_VIEW_HEIGHT_SIZABLE = 16;
const WK_USER_SCRIPT_INJECTION_AT_DOCUMENT_START = 0;
const WK_NAVIGATION_CANCEL = 0;
const WK_NAVIGATION_ALLOW = 1;
const WK_PERMISSION_DENY = 0;
const NS_URL_ERROR_CANCELLED = -999;
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
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

// Registered Objective-C classes retain their IMPs for the entire process.
// Keep the owning JSCallback and framework handles alive even after the window closes.
const runtimeOwners: Objc[] = [];

/** Own a single AppKit window and WKWebView using only Bun FFI and system frameworks. */
export class MacosWebview {
  private readonly objc = new Objc();
  private readonly window: ObjcObject;
  private readonly webview: ObjcObject;
  private readonly controller: ObjcObject;
  private readonly retained: ObjcObject[] = [];
  private readonly diagnostics: WebviewDiagnostics;
  private firstScriptMessage = false;
  private firstDelivery = false;
  private loadStartedAt = 0;
  private startupCheckpoint = 0;
  private closed = false;
  private rulesReady = false;
  private coreReady = false;
  private navigationStarted = false;
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
  ) {
    const o = this.objc;
    this.diagnostics = new WebviewDiagnostics(hooks.log);
    runtimeOwners.push(o);
    const required = (value: ObjcObject | null) => {
      if (!value) {
        throw new Error("AppKit object creation failed.");
      }
      return value;
    };
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
      const configuration = o.object("WKWebViewConfiguration");
      this.controller = o.object("WKUserContentController");
      this.retained.push(configuration, this.controller);
      const scheme = o.delegate([
        {
          selector: "webView:startURLSchemeTask:",
          arguments: 2,
          encoding: "v@:@@",
          call: (_self, _cmd, _view, task) => {
            if (task && !this.closed) {
              this.serve(task);
            }
          },
        },
        {
          selector: "webView:stopURLSchemeTask:",
          arguments: 2,
          encoding: "v@:@@",
          call: () => this.diagnostics.record("asset-stopped"),
        },
      ]);
      this.retained.push(scheme);
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
            if (this.closed || !message) {
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
      this.retained.push(scriptHandler);
      o.send(
        this.controller,
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
      this.retained.push(script);
      o.send(this.controller, "addUserScript:", script);
      o.send(configuration, "setUserContentController:", this.controller);
      o.send(
        configuration,
        "setWebsiteDataStore:",
        application.dataStore(config.window.view),
      );
      this.webview = o.webview(
        initialSize.width,
        initialSize.height,
        configuration,
      );
      const cancelDownload = o.block(1, () => {});
      const navigation = o.delegate([
        {
          selector: "webView:decidePolicyForNavigationAction:decisionHandler:",
          arguments: 3,
          encoding: "v@:@@@?",
          call: (_self, _cmd, _view, action, decision) => {
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
            this.diagnostics.record("action-policy", {
              allowed,
            });
            o.decide(
              decision ?? null,
              allowed ? WK_NAVIGATION_ALLOW : WK_NAVIGATION_CANCEL,
            );
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
            if (!this.closed) {
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
            if (!this.closed && navigation === this.documentNavigation) {
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
            this.diagnostics.record("process-terminated");
            hooks.log("webview-process-failed", {
              kind: 1,
            });
            hooks.revoke("process-failed");
            if (!this.closed) {
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
      this.retained.push(navigation);
      o.send(this.webview, "setNavigationDelegate:", navigation);
      // Media permissions belong to WKUIDelegate, even when one object owns both contracts.
      o.send(this.webview, "setUIDelegate:", navigation);
      o.send(
        this.webview,
        "setAutoresizingMask:",
        NS_VIEW_WIDTH_SIZABLE | NS_VIEW_HEIGHT_SIZABLE,
      );
      o.send(o.send(this.window, "contentView"), "addSubview:", this.webview);
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
          return this.webview;
        },
        viewPolicy.origins,
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
          o.send(this.controller, "addContentRuleList:", rules);
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
    }
  }

  source(): string {
    const o = this.objc;
    return o.withAutoreleasePool(() =>
      o.text(o.send(o.send(this.webview, "URL"), "absoluteString")),
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
    const o = this.objc;
    o.withAutoreleasePool(() => {
      const url = o.send(
        o.class("NSURL"),
        "URLWithString:",
        o.string(platformUrl(this.config.window.home)),
      );
      const navigation = o.send(
        this.webview,
        "loadRequest:",
        o.send(o.class("NSURLRequest"), "requestWithURL:", url),
      );
      this.diagnostics.record("load-returned", {
        accepted: !!navigation,
      });
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
  /** Observe a stalled initial bridge at 5, 10 and 15 seconds without changing its deadline. */
  observeStartup(): void {
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
      loading: !!this.objc.send(this.webview, "isLoading"),
      provisional: !!this.provisionalNavigation,
      progress: this.objc.double(this.webview, "estimatedProgress"),
    });
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
        this.webview,
        "evaluateJavaScript:completionHandler:",
        this.objc.string(`__bunawayDeliver(${JSON.stringify(text)})`),
        completion,
      ),
    );
  }
  private serve(task: Pointer): void {
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
    if (this.controller) {
      o.send(
        this.controller,
        "removeScriptMessageHandlerForName:",
        o.string("bunaway"),
      );
      o.send(this.controller, "removeAllUserScripts");
    }
    if (this.webview) {
      o.send(this.webview, "stopLoading");
      o.send(this.webview, "setNavigationDelegate:", null);
      o.send(this.webview, "setUIDelegate:", null);
      o.send(this.webview, "removeFromSuperview");
      o.send(this.webview, "release");
    }
    if (this.window) {
      o.send(this.window, "setDelegate:", null);
      o.send(this.window, "close");
      o.send(this.window, "release");
    }
    for (const object of this.retained.reverse()) {
      o.send(object, "release");
    }
    this.retained.length = 0;
    o.releaseCallbacks();
  }
}
