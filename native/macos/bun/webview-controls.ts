import type { NativeWebView } from "@bunaway/plugin-api/native";
import { BunawayError } from "@bunaway/protocol";
import type { Objc, ObjcObject } from "./objc.ts";
import { macosOrigin, platformUrl } from "./urls.ts";

/** Public WKWebView controls. The window owner validates lifetime before every native call. */
export class MacosWebviewControls implements NativeWebView {
  constructor(
    private readonly objc: Pick<
      Objc,
      | "send"
      | "text"
      | "class"
      | "string"
      | "selector"
      | "double"
      | "setDouble"
      | "withAutoreleasePool"
    >,
    private readonly requireWebview: () => ObjcObject,
    private readonly origins: readonly string[],
    private readonly window: ObjcObject,
    private readonly isApplicationActive: () => boolean,
  ) {}

  getState(): ReturnType<NativeWebView["getState"]> {
    const view = this.requireWebview();
    const o = this.objc;
    return o.withAutoreleasePool(() => {
      const source = o.text(o.send(o.send(view, "URL"), "absoluteString"));
      return {
        // Expose the declared app URL, as on Windows, rather than WebKit's asset transport scheme.
        url: source.replace(
          /^bunaway:\/\/app\.bunaway\.local(?=[:/#?]|$)/,
          "https://app.bunaway.local",
        ),
        title: o.text(o.send(view, "title")),
        loading: !!o.send(view, "isLoading"),
        canGoBack: !!o.send(view, "canGoBack"),
        canGoForward: !!o.send(view, "canGoForward"),
        zoomFactor: this.zoomFactor(view),
        focused: this.hasInputFocus(view),
      };
    });
  }

  /**
   * Whether the application is active, the window is key and the first responder is the
   * WKWebView or one of its descendants. Reading never changes the responder chain.
   */
  private hasInputFocus(view: ObjcObject): boolean {
    const o = this.objc;
    if (!this.isApplicationActive() || !o.send(this.window, "isKeyWindow")) {
      return false;
    }
    const responder = o.send(this.window, "firstResponder");
    // A non-view responder (the window itself or a view or window controller) is not the WebView.
    if (!responder || !o.send(responder, "isKindOfClass:", o.class("NSView"))) {
      return false;
    }
    return responder === view || !!o.send(responder, "isDescendantOf:", view);
  }

  navigate(url: string): void {
    let parsed: URL | undefined;
    try {
      parsed = new URL(url);
    } catch {
      /* Malformed URLs share the origin-denied result. */
    }
    if (
      !parsed ||
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      url.includes("\0") ||
      !this.origins.includes(macosOrigin(parsed.href))
    ) {
      throw new BunawayError({
        code: "PERMISSION_DENIED",
        message: "WebView navigation origin denied.",
      });
    }
    const view = this.requireWebview();
    const o = this.objc;
    o.withAutoreleasePool(() => {
      const address = o.send(
        o.class("NSURL"),
        "URLWithString:",
        o.string(platformUrl(parsed.href)),
      );
      if (!address) {
        throw new BunawayError({
          code: "INVALID_ARGUMENT",
          message: "Invalid WebView navigation URL.",
        });
      }
      o.send(
        view,
        "loadRequest:",
        o.send(o.class("NSURLRequest"), "requestWithURL:", address),
      );
    });
  }

  /** `reloadFromOrigin` is an end-to-end reload; the plain `reload` revalidates cached entries. */
  reload(ignoreCache = false): void {
    this.objc.withAutoreleasePool(() =>
      this.objc.send(
        this.requireWebview(),
        ignoreCache ? "reloadFromOrigin" : "reload",
      ),
    );
  }
  stop(): void {
    this.objc.withAutoreleasePool(() =>
      this.objc.send(this.requireWebview(), "stopLoading"),
    );
  }
  goBack(): boolean {
    return this.go("canGoBack", "goBack");
  }
  goForward(): boolean {
    return this.go("canGoForward", "goForward");
  }
  private go(available: string, navigate: string): boolean {
    const view = this.requireWebview();
    return this.objc.withAutoreleasePool(() => {
      if (!this.objc.send(view, available)) {
        return false;
      }
      return !!this.objc.send(view, navigate);
    });
  }
  private zoomFactor(view: ObjcObject): number {
    const o = this.objc;
    if (!o.send(view, "respondsToSelector:", o.selector("pageZoom"))) {
      throw new BunawayError({
        code: "UNSUPPORTED",
        message: "WKWebView page zoom is unavailable.",
      });
    }
    return o.double(view, "pageZoom");
  }
  setZoomFactor(factor: number): number {
    if (!Number.isFinite(factor) || factor < 0.25 || factor > 5) {
      throw new BunawayError({
        code: "INVALID_ARGUMENT",
        message: "Zoom factor must be between 0.25 and 5.",
      });
    }
    const view = this.requireWebview();
    return this.objc.withAutoreleasePool(() => {
      this.zoomFactor(view);
      this.objc.setDouble(view, "setPageZoom:", factor);
      return this.zoomFactor(view);
    });
  }
  openDevTools(): never {
    throw new BunawayError({
      code: "UNSUPPORTED",
      message: "WKWebView DevTools control is not implemented.",
    });
  }
}
