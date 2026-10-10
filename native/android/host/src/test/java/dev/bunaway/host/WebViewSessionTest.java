package dev.bunaway.host;

import static dev.bunaway.host.Protocol.*;

import static org.junit.Assert.*;

import org.junit.Test;

/** Checks document revocation and ordered input independently of Android's main looper. */
public class WebViewSessionTest {
    private WebViewSession session() {
        return new WebViewSession("view-test", new Protocol(object("type", "object")));
    }

    @Test
    public void requiresHelloAndStopsAfterClose() {
        WebViewSession session = session();
        assertFalse(session.acceptsReplies());
        assertNotNull(session.receive("{\"kind\":\"hello\"}"));
        assertTrue(session.acceptsReplies());
        assertNotNull(session.receive("{\"kind\":\"invoke\"}"));
        assertNotNull(session.receive("{\"kind\":\"close\"}"));
        assertFalse(session.acceptsReplies());
        assertTrue(session.isClosed());
        assertNull(session.receive("malformed queued input"));
    }

    @Test
    public void revocationDropsQueuedInputAndCannotReopen() {
        WebViewSession session = session();
        session.close();
        session.close();
        assertNull(session.receive("{\"kind\":\"hello\"}"));
        assertFalse(session.acceptsReplies());
        assertTrue(session.isClosed());
    }

    @Test
    public void invalidInputPermanentlyClosesItsDocument() {
        for (String input :
                new String[] {"{\"kind\":\"invoke\"}", "{\"kind\":\"result\"}", "invalid"}) {
            WebViewSession session = session();
            assertThrows(RuntimeException.class, () -> session.receive(input));
            assertTrue(session.isClosed());
            assertNull(session.receive("{\"kind\":\"hello\"}"));
            assertFalse(session.acceptsReplies());
        }
        WebViewSession session = session();
        session.receive("{\"kind\":\"hello\"}");
        assertThrows(RuntimeException.class, () -> session.receive("{\"kind\":\"event\"}"));
        assertFalse(session.acceptsReplies());
    }
}
