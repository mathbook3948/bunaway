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
      };
    });
  }

  navigate(url: string): void {
    let allowed = false;
    try {
      const parsed = new URL(url);
      allowed =
        (parsed.protocol === "http:" || parsed.protocol === "https:") &&
        !url.includes("\0") &&
        this.origins.includes(macosOrigin(url));
    } catch {
      /* Malformed URLs share the origin-denied result. */
    }
    if (!allowed) {
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
        o.string(platformUrl(url)),
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

  reload(): void {
    this.objc.withAutoreleasePool(() =>
      this.objc.send(this.requireWebview(), "reload"),
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
