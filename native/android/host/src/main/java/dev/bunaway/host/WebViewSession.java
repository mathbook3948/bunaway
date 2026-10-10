package dev.bunaway.host;

import static dev.bunaway.host.Protocol.require;

import java.util.Arrays;
import java.util.List;

/** Owns one document's input state while the writer validates messages off the UI thread. */
final class WebViewSession {
    private static final List<String> CLIENT_KINDS =
            Arrays.asList("hello", "invoke", "listen", "unlisten", "cancel", "close");

    final String context;
    private final Protocol protocol;
    private volatile boolean ready;
    private volatile boolean closed;

    WebViewSession(String context, Protocol protocol) {
        this.context = context;
        this.protocol = protocol;
    }

    /** Called only by the ordered writer. Revoked queued input is discarded without parsing. */
    Protocol.Validated receive(String text) {
        if (closed) return null;
        try {
            Protocol.Validated message = protocol.parseValidated(text);
            String kind = message.kind();
            require(CLIENT_KINDS.contains(kind), "Invalid WebView direction");
            require(ready || kind.equals("hello"), "Expected WebView hello");
            // Navigation may revoke this document while the writer is validating its message.
            if (closed) return null;
            ready = true;
            if (kind.equals("close")) closed = true;
            return message;
        } catch (RuntimeException error) {
            closed = true;
            throw error;
        }
    }

    /** A reply proxy cannot deliver before a valid hello or after document closure. */
    boolean acceptsReplies() {
        return ready && !closed;
    }

    boolean isClosed() {
        return closed;
    }

    /** Main-thread navigation and owner shutdown revoke queued writer work immediately. */
    void close() {
        closed = true;
    }
}
