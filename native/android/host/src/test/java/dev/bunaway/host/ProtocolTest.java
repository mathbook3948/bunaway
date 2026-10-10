package dev.bunaway.host;

import static dev.bunaway.host.Protocol.*;
import static dev.bunaway.host.ProtocolLimits.*;

import static org.junit.Assert.*;

import com.google.gson.JsonArray;
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
    public void earlyKindCheckPreservesOptionalFieldsAndOtherConstraints() {
        JsonArray required = new JsonArray();
        required.add("version");
        Protocol protocol =
                new Protocol(
                        object(
                                "type",
                                "object",
                                "properties",
                                object(
                                        "kind",
                                        object("const", "example"),
                                        "version",
                                        object("const", 1)),
                                "required",
                                required));
        assertNotNull(protocol.parse("{\"version\":1}"));
        assertNotNull(protocol.parse("{\"kind\":\"example\",\"version\":1}"));
        assertThrows(
                IllegalArgumentException.class,
                () -> protocol.parse("{\"kind\":\"other\",\"version\":1}"));
        assertThrows(
                IllegalArgumentException.class,
                () -> protocol.parse("{\"kind\":null,\"version\":1}"));
        assertThrows(
                IllegalArgumentException.class,
                () -> protocol.parse("{\"kind\":\"example\",\"version\":2}"));
        assertThrows(
                IllegalArgumentException.class, () -> protocol.parse("{\"kind\":\"example\"}"));
    }

    @Test
    public void ownsSchemaAndItsCompiledPatterns() {
        JsonObject schema =
                object(
                        "type",
                        "object",
                        "properties",
                        object("name", object("type", "string", "pattern", "^[a-z]+$")));
        Protocol protocol = new Protocol(schema);
        schema.getAsJsonObject("properties")
                .getAsJsonObject("name")
                .addProperty("pattern", "^[0-9]+$");
        assertNotNull(protocol.parse("{\"name\":\"abc\"}"));
        assertThrows(IllegalArgumentException.class, () -> protocol.parse("{\"name\":\"123\"}"));
    }

    @Test
    public void utf8BoundsCountMultibyteTextNearLimit() {
        Protocol protocol = new Protocol(object("type", "object"));
        String fitting = "{\"x\":\"" + "한".repeat((MAX_MESSAGE_BYTES - 8) / 3) + "\"}";
        assertNotNull(protocol.parse(fitting));
        assertThrows(
                IllegalArgumentException.class,
                () -> protocol.parse(fitting.replace("\"}", "한\"}")));
        assertThrows(
                IllegalArgumentException.class,
                () -> protocol.encode(object("x", "한".repeat(MAX_MESSAGE_BYTES / 3))));
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
    public void depthScanDistinguishesEscapedQuotesFromContainers() {
        Protocol unrestricted = new Protocol(object("type", "object"));
        for (String content :
                new String[] {"[".repeat(1000), "\\\"[{}]", "\\\\\"[{}]", "\\".repeat(200)}) {
            JsonObject value = object("value", content);
            assertEquals(value, unrestricted.parse(value.toString()));
        }
        String deep = "[".repeat(MAX_JSON_DEPTH + 2) + "]".repeat(MAX_JSON_DEPTH + 2);
        assertThrows(
                IllegalArgumentException.class,
                () -> unrestricted.parse("{\"text\":\"\\\\\",\"deep\":" + deep + "}"));
        assertThrows(RuntimeException.class, () -> unrestricted.parse("{\"text\":\"unterminated"));
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
        frame.remove("payload");
        String forwarded = process.encode(frame, message.parseValidated("\r\n" + hello + "\n"));
        assertFalse(forwarded.contains("\n"));
        assertFalse(forwarded.contains("\r"));
        assertEquals(payload, process.parse(forwarded).getAsJsonObject("payload"));
        for (String field : new String[] {"payload", "\\u0070ayload"}) {
            String raw = hello.replace("\"major\":1", "\"major\":1.0");
            String wire =
                    forwarded.substring(0, forwarded.lastIndexOf(",\"payload\":"))
                            + ",\"payload\":{},\""
                            + field
                            + "\": "
                            + raw
                            + ",\"context\":\"last-view\"}";
            Protocol.Frame parsed = process.parseFrame(wire);
            assertEquals(raw, parsed.webJson);
            assertEquals(message.parse(raw), message.parse(parsed.webJson));
            assertEquals("last-view", text(parsed.value, "context"));
        }
        assertThrows(
                RuntimeException.class, () -> message.parseValidated(hello + ",\"runtime\":{}"));
        assertThrows(RuntimeException.class, () -> message.parseValidated(hello + "\n" + hello));
        assertThrows(
                IllegalArgumentException.class,
                () ->
                        process.encode(
                                frame,
                                new Protocol(object("type", "object")).parseValidated("{}")));
        frame.add("payload", payload);
        payload.addProperty("unexpected", true);
        assertThrows(IllegalArgumentException.class, () -> process.encode(frame));
        assertThrows(IllegalArgumentException.class, () -> process.parse(frame.toString()));
    }

    @Test
    public void forwardedPayloadStillCountsEnvelopeDepthAndBytes() {
        Protocol unrestricted = new Protocol(object("type", "object"));
        String nested = "{\"x\":".repeat(MAX_JSON_DEPTH) + "0" + "}".repeat(MAX_JSON_DEPTH);
        Protocol.Validated deepest = unrestricted.parseValidated(nested);
        assertThrows(IllegalArgumentException.class, () -> unrestricted.encode(object(), deepest));
        String large = "{\"x\":\"" + "a".repeat(MAX_MESSAGE_BYTES - 8) + "\"}";
        Protocol.Validated largest = unrestricted.parseValidated(large);
        assertThrows(IllegalArgumentException.class, () -> unrestricted.encode(object(), largest));
        String escaped = "{\"x\":\"\\n\\r\\\"\\\\한글😀\"}";
        assertEquals(
                unrestricted.parse(escaped),
                unrestricted
                        .parse(unrestricted.encode(object(), unrestricted.parseValidated(escaped)))
                        .getAsJsonObject("payload"));
        String wire =
                "{\"kind\":\"web\",\"payload\":{"
                        + "\"payload\":\"quoted \\\"},[ text\",\"list\":[{},1e2,null]}}";
        Protocol.Frame parsed = unrestricted.parseFrame(wire);
        assertEquals(parsed.value.get("payload"), unrestricted.parse(parsed.webJson));
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

    @Test
    public void preservesLargeUnicodeStringsAndRejectsEveryUnpairedSurrogate() {
        Protocol unrestricted = new Protocol(object("type", "object"));
        String prefix = "plain 한글 😀".repeat(8192);
        JsonObject valid = object(prefix, prefix + "\ud7ff\ue000");
        assertEquals(valid, unrestricted.parse(unrestricted.encode(valid)));
        for (String invalid :
                new String[] {"\ud800", "\udfff", "\ud800x", "\udfff\ud800", "\ud800\ud800"}) {
            JsonObject value = object("data", prefix + invalid);
            JsonObject key = object(prefix + invalid, true);
            assertThrows(IllegalArgumentException.class, () -> unrestricted.encode(value));
            assertThrows(
                    IllegalArgumentException.class, () -> unrestricted.parse(value.toString()));
            assertThrows(IllegalArgumentException.class, () -> unrestricted.encode(key));
            assertThrows(IllegalArgumentException.class, () -> unrestricted.parse(key.toString()));
        }
        assertThrows(
                IllegalArgumentException.class,
                () -> unrestricted.encode(object("number", Double.POSITIVE_INFINITY)));
    }
}
