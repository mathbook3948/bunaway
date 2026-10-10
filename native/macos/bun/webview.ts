import { dlopen, type Pointer, ptr, toArrayBuffer } from "bun:ffi";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";
import { clampWindowSize } from "../../../packages/plugin-api/src/native.ts";
import type { MacosConfig } from "./config.ts";
import { Objc, type ObjcObject } from "./objc.ts";
import { macosOrigin, platformUrl, resourceRules } from "./urls.ts";

const NS_APPLICATION_ACTIVATION_POLICY_REGULAR = 0;
const NS_VIEW_WIDTH_SIZABLE = 2;
const NS_VIEW_HEIGHT_SIZABLE = 16;
const WK_USER_SCRIPT_INJECTION_AT_DOCUMENT_START = 0;
const WK_NAVIGATION_CANCEL = 0;
const WK_NAVIGATION_ALLOW = 1;
const WK_PERMISSION_DENY = 0;
const UI_PUMP_INTERVAL_MS = 5;
const MAX_EVENTS_PER_TICK = 64;
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
  private readonly runLoop = dlopen(
    "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation",
    {
      CFRunLoopRunInMode: {
        args: [
          "ptr",
          "f64",
          "bool",
        ],
        returns: "i32",
      },
    },
  );
  private readonly app: ObjcObject;
  private readonly window: ObjcObject;
  private readonly webview: ObjcObject;
  private readonly controller: ObjcObject;
  private readonly retained: ObjcObject[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private closed = false;
  private rulesReady = false;
  private coreReady = false;
  private navigationStarted = false;
  readonly ready: Promise<void>;

  constructor(
    private readonly config: MacosConfig,
    readonly hooks: {
      receive(source: string, raw: string): void;
      revoke(reason: string): void;
      close(): void;
      tick(): void;
      log(event: string, fields?: object): void;
      fail(error: unknown): void;
    },
  ) {
    const o = this.objc;
    runtimeOwners.push(o);
    const required = (value: ObjcObject | null) => {
      if (!value) {
        throw new Error("AppKit object creation failed.");
      }
      return value;
    };
    this.app = required(o.send(o.class("NSApplication"), "sharedApplication"));
    o.send(
      this.app,
      "setActivationPolicy:",
      NS_APPLICATION_ACTIVATION_POLICY_REGULAR,
    );
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
    ]);
    const appDelegate = o.delegate([
      {
        selector: "applicationShouldTerminate:",
        arguments: 1,
        returns: "ptr",
        encoding: "q@:@",
        call: () => {
          if (!this.closed) {
            hooks.close();
          }
          return null;
        },
      },
    ]);
    this.retained.push(windowDelegate, appDelegate);
    o.send(this.app, "setDelegate:", appDelegate);
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
        call() {},
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
          const body = o.send(message, "body");
          // WebKit accepts NSDate and other values that would throw a native
          // exception during JSON serialization, before protocol validation.
          if (
            !o.send(o.class("NSJSONSerialization"), "isValidJSONObject:", body)
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
      o.send(o.class("WKWebsiteDataStore"), "nonPersistentDataStore"),
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
              hooks.revoke("navigation");
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
          o.decide(
            decision ?? null,
            allowed ? WK_NAVIGATION_ALLOW : WK_NAVIGATION_CANCEL,
          );
        },
      },
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
        call: () =>
          hooks.log("navigation-completed", {
            success: true,
            source: this.source(),
          }),
      },
      {
        selector: "webViewWebContentProcessDidTerminate:",
        arguments: 1,
        encoding: "v@:@",
        call: () => {
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
    o.send(this.app, "finishLaunching");
    o.send(this.window, "center");
    o.send(this.window, "makeKeyAndOrderFront:", null);
    o.send(this.app, "activateIgnoringOtherApps:", 1);
    const viewPolicy = config.policy.views.find(
      (view) => view.id === config.window.view,
    );
    if (!viewPolicy) {
      throw new Error("Missing view policy.");
    }
    this.ready = new Promise<void>((resolveReady, reject) => {
      const completion = o.block(2, (_block, rules, error) => {
        if (this.closed) {
          reject(new Error("WebView closed during setup."));
          return;
        }
        if (!rules || error) {
          reject(new Error("WebKit resource-rule compilation failed."));
          return;
        }
        o.send(this.controller, "addContentRuleList:", rules);
        this.rulesReady = true;
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
    // AppKit stays on Bun's main thread. Bounded, nonblocking turns give Bun's
    // event loop time for Worker messages, I/O and shutdown between native events.
    this.timer = setInterval(() => {
      if (this.closed) {
        return;
      }
      try {
        o.withAutoreleasePool(() => {
          this.runLoop.symbols.CFRunLoopRunInMode(
            o.string("kCFRunLoopDefaultMode"),
            0,
            true,
          );
          for (let index = 0; index < MAX_EVENTS_PER_TICK; index++) {
            const event = o.nextEvent(this.app);
            if (!event) {
              break;
            }
            o.send(this.app, "sendEvent:", event);
          }
          o.send(this.app, "updateWindows");
          hooks.tick();
        });
      } catch (error) {
        hooks.fail(error);
      }
    }, UI_PUMP_INTERVAL_MS);
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
    const o = this.objc;
    o.withAutoreleasePool(() => {
      const url = o.send(
        o.class("NSURL"),
        "URLWithString:",
        o.string(platformUrl(this.config.window.home)),
      );
      o.send(
        this.webview,
        "loadRequest:",
        o.send(o.class("NSURLRequest"), "requestWithURL:", url),
      );
    });
  }
  deliver(text: string): void {
    if (this.closed) {
      return;
    }
    // Worker messages arrive outside the native run-loop turn's autorelease pool.
    this.objc.withAutoreleasePool(() =>
      this.objc.send(
        this.webview,
        "evaluateJavaScript:completionHandler:",
        this.objc.string(`__bunawayDeliver(${JSON.stringify(text)})`),
        null,
      ),
    );
  }
  private serve(task: Pointer): void {
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
    o.send(response, "release");
  }
  /** Detach native delegates before releasing objects. Safe after repeated shutdown requests. */
  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.timer) {
      clearInterval(this.timer);
    }
    const o = this.objc;
    o.send(
      this.controller,
      "removeScriptMessageHandlerForName:",
      o.string("bunaway"),
    );
    o.send(this.controller, "removeAllUserScripts");
    o.send(this.webview, "stopLoading");
    o.send(this.webview, "setNavigationDelegate:", null);
    o.send(this.webview, "setUIDelegate:", null);
    o.send(this.window, "setDelegate:", null);
    o.send(this.app, "setDelegate:", null);
    o.send(this.window, "close");
    o.send(this.webview, "removeFromSuperview");
    o.send(this.webview, "release");
    o.send(this.window, "release");
    for (const object of this.retained.reverse()) {
      o.send(object, "release");
    }
    this.runLoop.close();
  }
}
