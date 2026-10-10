package dev.bunaway.host;

import static dev.bunaway.host.Protocol.require;

import androidx.webkit.WebMessageCompat;
import androidx.webkit.WebMessagePortCompat;
import androidx.webkit.WebViewFeature;

/** Owns the native endpoint of one document's message channel. */
final class WebViewChannel implements AutoCloseable {
    // Renderer injects this single wire prefix into the document-start bridge.
    static final String REQUEST_PREFIX = "@bunaway-port:";
    final WebViewSession session;
    private final WebMessagePortCompat port;
    private volatile boolean closed;

    /** The runtime owns callback scheduling and validates input on its bounded FIFO writer. */
    WebViewChannel(
            WebViewSession session,
            WebMessagePortCompat port,
            BunProcess runtime,
            Runnable invalid) {
        this.session = session;
        this.port = port;
        port.setWebMessageCallback(
                runtime.messageHandler,
                new WebMessagePortCompat.WebMessageCallbackCompat() {
                    @Override
                    public void onMessage(WebMessagePortCompat source, WebMessageCompat message) {
                        if (closed || session.isClosed()) return;
                        try {
                            require(message != null, "Text message required");
                            String text = message.getData();
                            require(
                                    text != null
                                            && text.length() <= ProtocolLimits.MAX_MESSAGE_BYTES,
                                    "Invalid WebView message size");
                            runtime.sendWeb(session, text, invalid);
                        } catch (RuntimeException error) {
                            session.close();
                            runtime.reportInvalidChannel(WebViewChannel.this, invalid);
                        }
                    }
                });
    }

    static boolean supported() {
        return WebViewFeature.isFeatureSupported(WebViewFeature.CREATE_WEB_MESSAGE_CHANNEL)
                && WebViewFeature.isFeatureSupported(WebViewFeature.POST_WEB_MESSAGE)
                && WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_PORT_POST_MESSAGE)
                && WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_PORT_CLOSE)
                && WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_CALLBACK_ON_MESSAGE)
                && WebViewFeature.isFeatureSupported(
                        WebViewFeature.WEB_MESSAGE_PORT_SET_MESSAGE_CALLBACK);
    }

    /** Called on the ordered runtime dispatcher, which also owns the delivery deadline. */
    void send(BunProcess.WebMessage message) {
        if (closed || !session.acceptsReplies()) return;
        message.checkDirection();
        try {
            port.postMessage(new WebMessageCompat(message.json));
        } catch (RuntimeException error) {
            // Navigation may close this endpoint while WebView is posting the message.
            if (!closed) throw error;
        }
    }

    /**
     * Revoke input before closing the endpoint; callbacks already queued will discard their work.
     */
    @Override
    public void close() {
        synchronized (this) {
            if (closed) return;
            closed = true;
        }
        session.close();
        try {
            port.close();
        } catch (RuntimeException error) {
            // Revocation is already visible; a WebView cleanup failure must not stop Bun cleanup.
            android.util.Log.w("BunawayHost", "Message port cleanup failed", error);
        }
    }
}
