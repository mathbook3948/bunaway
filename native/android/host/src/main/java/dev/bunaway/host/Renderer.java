package dev.bunaway.host;

import static dev.bunaway.host.AppAssets.originOf;
import static dev.bunaway.host.Protocol.*;

import android.content.Context;
import android.graphics.Bitmap;
import android.net.Uri;
import android.view.ViewGroup;
import android.webkit.ConsoleMessage;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import com.google.gson.JsonObject;

import java.io.ByteArrayInputStream;
import java.io.FileNotFoundException;
import java.io.IOException;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.function.Consumer;

/**
 * Owns one document session and exposes the bridge only to the trusted main-frame origin.
 *
 * <p>The WebView serves packaged assets for the app origin and blocks every other request. Each
 * main-frame navigation opens a new backend view context and revokes the previous one, so replies
 * never reach a different document. All methods run on the main thread.
 */
final class Renderer {
    /** Message kinds the client SDK may send; the rest belong to the backend direction. */
    private static final List<String> CLIENT_KINDS =
            Arrays.asList("hello", "invoke", "listen", "unlisten", "cancel", "close");

    /** Message kinds the backend may deliver to the document. */
    private static final List<String> SERVER_KINDS =
            Arrays.asList("hello", "result", "error", "event", "subscription-error");

    /** Headers for packaged assets: no sniffing, no caching and same-origin resources only. */
    private static final Map<String, String> HEADERS;

    static {
        Map<String, String> headers = new HashMap<>();
        headers.put("X-Content-Type-Options", "nosniff");
        headers.put("Cache-Control", "no-store");
        headers.put(
                "Content-Security-Policy",
                "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src"
                        + " 'self'; connect-src 'self'; frame-src 'self'; object-src 'none';"
                        + " base-uri 'none'; form-action 'none'");
        HEADERS = Collections.unmodifiableMap(headers);
    }

    final WebView view;
    private final AppAssets assets;
    private final BunProcess runtime;
    private final Consumer<String> failed;

    /** Backend view context of the current document, or null while no session is open. */
    private String context;

    /** Reply channel bound to the current document by its first hello message. */
    private JavaScriptReplyProxy reply;

    private boolean closed;

    /**
     * Creates the WebView and installs the asset handler and bridge. Call {@link #load} to open the
     * home page.
     *
     * @param activity Activity context that owns the WebView
     * @param failed called on the main thread when the document or bridge can no longer continue
     * @throws IllegalStateException when the installed WebView lacks the required bridge features
     * @throws IOException when the packaged bridge script cannot be read
     */
    Renderer(Context activity, AppAssets assets, BunProcess runtime, Consumer<String> failed)
            throws IOException {
        this.assets = assets;
        this.runtime = runtime;
        this.failed = failed;
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            throw new IllegalStateException("Update Android System WebView for the Bunaway bridge");
        }
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            throw new IllegalStateException(
                    "Update Android System WebView for document-start scripts");
        }
        view = new WebView(activity);
        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);

        // WebView injects the native object only for the app origin. Subframes of the same
        // origin also receive it, so the callback checks the main frame itself.
        WebViewCompat.addWebMessageListener(
                view,
                "bunawayNative",
                Collections.singleton(assets.origin),
                (webView, message, origin, mainFrame, proxy) -> {
                    if (!mainFrame
                            || !originOf(origin).equals(assets.origin)
                            || closed
                            || context == null) {
                        return;
                    }
                    try {
                        String data = message.getData();
                        require(data != null, "Text message required");
                        JsonObject payload = assets.webProtocol.parse(data);
                        String kind = text(payload, "kind");
                        require(CLIENT_KINDS.contains(kind), "Invalid WebView direction");
                        // The first message of a document must be hello and binds its reply proxy.
                        if (reply == null) {
                            require(kind.equals("hello"), "Expected WebView hello");
                            reply = proxy;
                        }
                        runtime.send("web", "context", context, "payload", payload);
                        if (kind.equals("close")) context = null;
                    } catch (Exception error) {
                        revoke();
                        failed.accept("Invalid WebView message");
                    }
                });
        // bridge.js adapts the native object to the chrome.webview API the client SDK expects.
        WebViewCompat.addDocumentStartJavaScript(
                view, assets.read("bridge.js"), Collections.singleton(assets.origin));
        view.setWebChromeClient(
                new WebChromeClient() {
                    @Override
                    public boolean onConsoleMessage(ConsoleMessage message) {
                        android.util.Log.i("BunawayWeb", message.message());
                        return true;
                    }
                });
        view.setWebViewClient(
                new WebViewClient() {
                    /** Cancels navigation away from the app origin. */
                    @Override
                    public boolean shouldOverrideUrlLoading(
                            WebView webView, WebResourceRequest request) {
                        return !originOf(request.getUrl()).equals(assets.origin);
                    }

                    @Override
                    public WebResourceResponse shouldInterceptRequest(
                            WebView webView, WebResourceRequest request) {
                        return assetResponse(request);
                    }

                    /** Replaces the backend session when a new main-frame document starts. */
                    @Override
                    public void onPageStarted(WebView webView, String url, Bitmap icon) {
                        revoke();
                        if (closed || !originOf(Uri.parse(url)).equals(assets.origin)) {
                            webView.stopLoading();
                            return;
                        }
                        context = "view-" + UUID.randomUUID();
                        runtime.send("session-open", "context", context, "viewId", assets.view);
                    }

                    @Override
                    public void onReceivedError(
                            WebView webView, WebResourceRequest request, WebResourceError error) {
                        if (request.isForMainFrame() && !closed) {
                            revoke();
                            failed.accept("WebView could not load the app");
                        }
                    }

                    /** Treats a crashed or killed renderer as fatal for this Activity. */
                    @Override
                    public boolean onRenderProcessGone(
                            WebView webView, RenderProcessGoneDetail detail) {
                        close();
                        failed.accept("WebView renderer exited. Reopen the app.");
                        return true;
                    }
                });
    }

    /**
     * Serves a GET request for the app origin from {@code assets/bunaway/web/}.
     *
     * <p>Other methods and origins receive 403, so the WebView never reaches the network. Paths
     * that could escape the web directory or expose hidden files are also rejected.
     */
    private WebResourceResponse assetResponse(WebResourceRequest request) {
        if (!request.getMethod().equals("GET")
                || !originOf(request.getUrl()).equals(assets.origin)) {
            return response(403, "Forbidden");
        }
        String path = request.getUrl().getEncodedPath();
        if (path == null) return response(404, "Not Found");
        if (path.equals("/")) path = "/index.html";
        // Decode once; deny traversal, separators, hidden files and framework inputs.
        String decoded = Uri.decode(path);
        if (decoded.indexOf('\\') >= 0 || decoded.indexOf('\0') >= 0) {
            return response(403, "Forbidden");
        }
        for (String segment : decoded.substring(1).split("/", -1)) {
            if (segment.isEmpty() || segment.startsWith(".")) return response(403, "Forbidden");
        }
        try {
            return new WebResourceResponse(
                    mimeOf(decoded),
                    "UTF-8",
                    200,
                    "OK",
                    HEADERS,
                    assets.context.getAssets().open("bunaway/web" + decoded));
        } catch (FileNotFoundException error) {
            return response(404, "Not Found");
        } catch (IOException error) {
            return response(500, "Asset Error");
        }
    }

    /** Maps the packaged web asset extensions to MIME types; unknown types are opaque bytes. */
    private static String mimeOf(String path) {
        String extension = path.substring(path.lastIndexOf('.') + 1).toLowerCase(Locale.ROOT);
        switch (extension) {
            case "html":
                return "text/html";
            case "js":
            case "mjs":
                return "text/javascript";
            case "css":
                return "text/css";
            case "json":
                return "application/json";
            case "svg":
                return "image/svg+xml";
            case "png":
                return "image/png";
            case "jpg":
            case "jpeg":
                return "image/jpeg";
            case "ico":
                return "image/x-icon";
            case "woff2":
                return "font/woff2";
            default:
                return "application/octet-stream";
        }
    }

    /** Loads the configured home page; the first page start opens the backend session. */
    void load() {
        view.loadUrl(assets.home);
    }

    /**
     * Delivers a backend message for view context {@code id} to the current document.
     *
     * <p>Messages for a revoked or older context are dropped. A message in the client direction
     * fails the document.
     */
    void receive(String id, JsonObject message) {
        if (closed || !id.equals(context)) return;
        try {
            require(
                    SERVER_KINDS.contains(text(message, "kind")),
                    "Invalid backend WebView direction");
            // The process boundary already validated the nested Web message. The proxy belongs to
            // its document.
            if (reply != null) reply.postMessage(message.toString());
        } catch (Exception error) {
            revoke();
            failed.accept("Invalid backend response");
        }
    }

    /** Ends the current backend view session and drops the document's reply proxy. */
    private void revoke() {
        if (context != null) runtime.send("revoke", "context", context);
        context = null;
        reply = null;
    }

    /** Revokes the session and destroys the WebView. Safe to call repeatedly. */
    void close() {
        if (closed) return;
        revoke();
        closed = true;
        if (view.getParent() instanceof ViewGroup) {
            ((ViewGroup) view.getParent()).removeView(view);
        }
        view.stopLoading();
        view.destroy();
    }

    private static WebResourceResponse response(int status, String reason) {
        return new WebResourceResponse(
                "text/plain",
                "UTF-8",
                status,
                reason,
                Collections.emptyMap(),
                new ByteArrayInputStream(new byte[0]));
    }
}
