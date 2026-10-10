package dev.bunaway.host;

import static dev.bunaway.host.Protocol.*;
import static dev.bunaway.host.ProtocolLimits.*;

import static org.junit.Assert.*;

import com.google.gson.JsonObject;

import org.junit.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;

/**
 * Checks the Java validator against the generated schemas packaged with the APK.
 *
 * <p>Gradle sets the {@code bunawayAssets} system property to the synced {@code assets/bunaway}
 * directory, so these tests always use the same schemas as the installed host.
 */
public class ProtocolTest {
    private final Protocol message;
    private final String hello =
            "{\"kind\":\"hello\",\"protocol\":{\"major\":1,\"minor\":0},\"features\":[],\"buildId\":\"android-test\"}";

    public ProtocolTest() throws Exception {
        message =
                new Protocol(
                        readObject(
                                new String(
                                        Files.readAllBytes(
                                                Paths.get(
                                                        System.getProperty("bunawayAssets"),
                                                        "message.schema.json")),
                                        StandardCharsets.UTF_8)));
    }

    private void rejects(String text) {
        assertThrows(RuntimeException.class, () -> message.parse(text));
    }

    @Test
    public void acceptsSharedProtocolAndNumericLexicalForms() {
        assertEquals("hello", text(message.parse(hello), "kind"));
        assertEquals(
                "hello",
                text(message.parse(hello.replace("\"major\":1", "\"major\":1.0")), "kind"));
    }

    @Test
    public void rejectsExtraFieldsMalformedJsonAndEnvelopeSpoofing() {
        assertThrows(IllegalArgumentException.class, () -> new Protocol(object("type", "number")));
        rejects(hello.substring(0, hello.length() - 1) + ",\"runtime\":{}}");
        rejects(hello + "false");
        rejects(hello.replace("\"kind\"", "'kind'"));
        rejects(hello.replace("hello", "session-open"));
        rejects(hello.replace("[]", "[\"x\",\"x\"]"));
        rejects(hello.replace("\"major\":1", "\"major\":1.5"));
        rejects(hello.replace("\"major\":1", "\"major\":\"1\""));
        rejects(hello.replace("\"major\":1", "\"major\":NaN"));
        rejects("/*comment*/" + hello);
        rejects(hello.replace("\"kind\"", "kind"));
    }

    @Test
    public void boundsBytesDepthAndUnicodeBeforeDispatch() {
        rejects(" ".repeat(MAX_MESSAGE_BYTES + 1));
        rejects("[".repeat(MAX_JSON_DEPTH + 2) + "]".repeat(MAX_JSON_DEPTH + 2));
        rejects(hello.replace("android-test", "\\ud800"));
    }

    @Test
    public void validatesNestedWebMessagesAtTheProcessBoundary() throws Exception {
        Protocol process =
                new Protocol(
                        readObject(
                                new String(
                                        Files.readAllBytes(
                                                Paths.get(
                                                        System.getProperty("bunawayAssets"),
                                                        "process.schema.json")),
                                        StandardCharsets.UTF_8)));
        JsonObject payload = message.parse(hello);
        JsonObject frame =
                object(
                        "ipc",
                        object("major", 1, "minor", 0),
                        "runtime",
                        object("id", "runtime-1", "generation", "generation-1"),
                        "kind",
                        "web",
                        "context",
                        "view-1",
                        "payload",
                        payload);
        assertEquals(payload, process.parse(process.encode(frame)).getAsJsonObject("payload"));
        payload.addProperty("unexpected", true);
        assertThrows(IllegalArgumentException.class, () -> process.encode(frame));
        assertThrows(IllegalArgumentException.class, () -> process.parse(frame.toString()));
    }

    @Test
    public void boundsInternalSerializationWithoutReparsing() {
        Protocol unrestricted = new Protocol(object("type", "object"));
        assertThrows(
                IllegalArgumentException.class,
                () -> unrestricted.encode(object("data", "x".repeat(MAX_MESSAGE_BYTES))));
        assertThrows(
                IllegalArgumentException.class,
                () -> unrestricted.encode(object("data", "\ud800")));
        JsonObject root = new JsonObject();
        JsonObject current = root;
        for (int depth = 0; depth <= MAX_JSON_DEPTH; depth++) {
            JsonObject nested = new JsonObject();
            current.add("nested", nested);
            current = nested;
        }
        assertThrows(IllegalArgumentException.class, () -> unrestricted.encode(root));
    }
}
