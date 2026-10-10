package dev.bunaway.host;

import static dev.bunaway.host.ProtocolLimits.*;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;
import com.google.gson.Strictness;

import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Validates the shared generated schema subset and bounds input before dispatch.
 *
 * <p>The schemas are generated from {@code @bunaway/protocol} and packaged with the APK. Only the
 * keywords and types this class implements are accepted, so a generator change that needs more
 * fails when the host loads its schemas instead of being silently ignored.
 */
final class Protocol {
    private static final Gson JSON = new GsonBuilder().setStrictness(Strictness.STRICT).create();
    // Java regex matches code points, so valid surrogate pairs are outside this range.
    private static final Pattern UNPAIRED_SURROGATE = Pattern.compile("[\\uD800-\\uDFFF]");
    private static final int NATIVE_UNICODE_SCAN_LENGTH = 1024;
    private static final List<String> KEYWORDS =
            Arrays.asList(
                    "$schema",
                    "type",
                    "const",
                    "enum",
                    "anyOf",
                    "properties",
                    "required",
                    "additionalProperties",
                    "items",
                    "minimum",
                    "maximum",
                    "minItems",
                    "maxItems",
                    "uniqueItems",
                    "maxLength",
                    "pattern");
    private static final List<String> TYPES =
            Arrays.asList("object", "array", "string", "integer", "boolean");

    /** Largest integer JavaScript can represent exactly ({@code Number.MAX_SAFE_INTEGER}). */
    private static final double MAX_SAFE_INTEGER = 9007199254740991.0;

    private final JsonObject schema;
    private final Map<String, Pattern> patterns = new HashMap<>();

    /** Owns the parsed tree and original wire text, so forwarding cannot observe later mutation. */
    static final class Validated {
        private final JsonObject value;
        private final String json;
        private final int depth;
        private final int payloadStart;
        private final int payloadEnd;

        private Validated(
                JsonObject value, String json, int depth, int payloadStart, int payloadEnd) {
            this.value = value;
            this.json = json;
            this.depth = depth;
            this.payloadStart = payloadStart;
            this.payloadEnd = payloadEnd;
        }

        String kind() {
            return text(value, "kind");
        }
    }

    /** A checked process frame and its web payload's original JSON slice, when present. */
    static final class Frame {
        final JsonObject value;
        final String webJson;

        private Frame(Validated parsed) {
            value = parsed.value;
            webJson =
                    parsed.kind().equals("web")
                            ? parsed.json.substring(parsed.payloadStart, parsed.payloadEnd)
                            : null;
        }
    }

    /**
     * @throws IllegalArgumentException when the schema uses a keyword or type outside the supported
     *     subset
     */
    Protocol(JsonObject schema) {
        this.schema = schema.deepCopy();
        checkSchema(this.schema);
    }

    private void checkSchema(JsonObject schema) {
        require(KEYWORDS.containsAll(schema.keySet()), "Unsupported schema keyword");
        // Packaged schemas are fixed for this owner; compile identifiers once, not per RPC.
        if (schema.has("pattern")) {
            String pattern = text(schema, "pattern");
            patterns.computeIfAbsent(pattern, Pattern::compile);
        }
        if (schema.has("type")) {
            require(TYPES.contains(text(schema, "type")), "Unsupported schema type");
        }
        if (schema.has("properties")) {
            for (JsonElement item : schema.getAsJsonObject("properties").asMap().values()) {
                checkSchema(item.getAsJsonObject());
            }
        }
        if (schema.has("anyOf")) {
            for (JsonElement item : schema.getAsJsonArray("anyOf")) {
                checkSchema(item.getAsJsonObject());
            }
        }
        if (schema.has("items")) checkSchema(schema.getAsJsonObject("items"));
    }

    /**
     * Parses untrusted text and returns it only when it matches this schema.
     *
     * @throws IllegalArgumentException when the text exceeds the byte or nesting limit, is not a
     *     strict JSON object, contains invalid Unicode or non-finite numbers, or fails the schema
     * @throws com.google.gson.JsonParseException when Gson rejects the JSON syntax
     */
    JsonObject parse(String text) {
        return parseValidated(text).value;
    }

    /** Keeps a checked response in wire form instead of serializing its payload tree again. */
    Frame parseFrame(String text) {
        return new Frame(parseValidated(text));
    }

    /** Validates once and retains an immutable message for embedding in a process envelope. */
    Validated parseValidated(String text) {
        checkSize(text);
        // Bound nesting before the parser allocates an attacker-controlled tree.
        int depth = 0;
        int payloadStart = -1;
        int payloadEnd = -1;
        // Record root payload boundaries while bounding nesting. Only the strict parser and
        // schema checks below authorize forwarding that slice.
        for (int index = 0; index < text.length(); index++) {
            char character = text.charAt(index);
            if (character == '"') {
                int end = stringEnd(text, index);
                int next = whitespaceEnd(text, end + 1);
                if (depth == 1
                        && next < text.length()
                        && text.charAt(next) == ':'
                        && isPayloadKey(text, index, end)) {
                    payloadStart = whitespaceEnd(text, next + 1);
                    payloadEnd = -1;
                }
                index = end;
            } else if (character == '{' || character == '[') {
                require(++depth <= MAX_JSON_DEPTH + 1, "JSON nesting too deep");
            } else if (character == '}' || character == ']') {
                depth--;
                if (depth == 0 && payloadStart >= 0 && payloadEnd < 0) payloadEnd = index;
            } else if (character == ',' && depth == 1 && payloadStart >= 0 && payloadEnd < 0) {
                payloadEnd = index;
            }
        }
        JsonElement parsed = JSON.fromJson(text, JsonElement.class);
        require(parsed != null && parsed.isJsonObject(), "JSON object required");
        int maximumDepth = checkDepth(parsed, 0);
        JsonObject value = parsed.getAsJsonObject();
        require(matches(schema, value), "Invalid protocol message");
        return new Validated(value, text, maximumDepth, payloadStart, payloadEnd);
    }

    private static int whitespaceEnd(String text, int index) {
        while (index < text.length() && Character.isWhitespace(text.charAt(index))) index++;
        return index;
    }

    /** Recognize escaped keys too; duplicate members use the last value, as Gson does. */
    private static boolean isPayloadKey(String text, int start, int end) {
        String key = text.substring(start + 1, end);
        if (key.equals("payload")) return true;
        return key.indexOf('\\') >= 0
                && "payload".equals(JSON.fromJson(text.substring(start, end + 1), String.class));
    }

    /** Skip string contents with native search; Gson still checks escapes and termination. */
    private static int stringEnd(String text, int start) {
        int end = start;
        while ((end = text.indexOf('"', end + 1)) >= 0) {
            int slash = end - 1;
            while (slash > start && text.charAt(slash) == '\\') slash--;
            if ((end - slash) % 2 == 1) return end;
        }
        return text.length();
    }

    /**
     * Validate an internal envelope without reparsing its serialization for pipe transport.
     *
     * @return the serialized JSON text
     * @throws IllegalArgumentException when the value is too deep, contains invalid Unicode or
     *     non-finite numbers, fails the schema, or serializes beyond the byte limit
     */
    String encode(JsonObject value) {
        checkDepth(value, 0);
        require(matches(schema, value), "Invalid protocol message");
        String text = value.toString();
        checkSize(text);
        return text;
    }

    /**
     * Wraps validated WebView text without walking or serializing its data a second time. Metadata
     * stays host-owned. The combined schema, nesting and wire size still apply.
     */
    String encode(JsonObject envelope, Validated payload) {
        require(!envelope.has("payload"), "Payload already supplied");
        checkDepth(envelope, 0);
        require(payload.depth + 1 <= MAX_JSON_DEPTH, "JSON nesting too deep");
        JsonObject frame = new JsonObject();
        for (Map.Entry<String, JsonElement> entry : envelope.entrySet()) {
            frame.add(entry.getKey(), entry.getValue());
        }
        frame.add("payload", payload.value);
        require(matches(schema, frame), "Invalid protocol message");
        String metadata = envelope.toString();
        String text =
                metadata.substring(0, metadata.length() - 1)
                        + (envelope.isEmpty() ? "" : ",")
                        + "\"payload\":"
                        // Strict JSON can contain literal line breaks only between tokens.
                        + singleLine(payload.json)
                        + "}";
        checkSize(text);
        return text;
    }

    private static String singleLine(String text) {
        if (text.indexOf('\n') >= 0) text = text.replace("\n", "");
        if (text.indexOf('\r') >= 0) text = text.replace("\r", "");
        return text;
    }

    private static void checkSize(String text) {
        // UTF-8 needs at most three bytes per UTF-16 code unit, including surrogate pairs.
        if (text.length() <= MAX_MESSAGE_BYTES / 3) return;
        require(text.length() <= MAX_MESSAGE_BYTES, "Message too large");
        require(
                text.getBytes(StandardCharsets.UTF_8).length <= MAX_MESSAGE_BYTES,
                "Message too large");
    }

    /**
     * Strict parsing also rejects trailing values and invalid UTF-16 before UTF-8 transport.
     *
     * @throws IllegalArgumentException when the value is not an object or violates the depth,
     *     Unicode or number checks
     * @throws com.google.gson.JsonParseException when Gson rejects the JSON syntax
     */
    static JsonObject readObject(String text) {
        JsonElement value = JSON.fromJson(text, JsonElement.class);
        require(value != null && value.isJsonObject(), "JSON object required");
        checkDepth(value, 0);
        return value.getAsJsonObject();
    }

    /**
     * Enforces the shared nesting limit and rejects values JavaScript peers cannot round-trip:
     * non-finite numbers and unpaired UTF-16 surrogates in strings or object keys.
     */
    private static int checkDepth(JsonElement value, int depth) {
        require(depth <= MAX_JSON_DEPTH, "JSON nesting too deep");
        int maximum = depth;
        if (value.isJsonObject()) {
            for (Map.Entry<String, JsonElement> entry : value.getAsJsonObject().entrySet()) {
                // Object keys are strings too, so check their Unicode with the same rule.
                require(depth < MAX_JSON_DEPTH, "JSON nesting too deep");
                checkUnicode(entry.getKey());
                maximum = Math.max(maximum, checkDepth(entry.getValue(), depth + 1));
            }
        } else if (value.isJsonArray()) {
            for (JsonElement item : value.getAsJsonArray()) {
                maximum = Math.max(maximum, checkDepth(item, depth + 1));
            }
        } else if (value.isJsonPrimitive()) {
            JsonPrimitive primitive = value.getAsJsonPrimitive();
            if (primitive.isNumber()) {
                require(Double.isFinite(primitive.getAsDouble()), "Non-finite JSON number");
            } else if (primitive.isString()) {
                checkUnicode(primitive.getAsString());
            }
        }
        return maximum;
    }

    private static void checkUnicode(String text) {
        // Android's native matcher avoids repeated String.charAt calls for large payloads.
        if (text.length() >= NATIVE_UNICODE_SCAN_LENGTH) {
            require(!UNPAIRED_SURROGATE.matcher(text).find(), "Invalid Unicode");
            return;
        }
        for (int index = 0; index < text.length(); index++) {
            char character = text.charAt(index);
            if (character < '\ud800' || character > '\udfff') continue;
            if (character > '\udbff'
                    || ++index == text.length()
                    || !Character.isLowSurrogate(text.charAt(index))) {
                throw new IllegalArgumentException("Invalid Unicode");
            }
        }
    }

    /**
     * Returns whether {@code value} satisfies {@code schema} for the supported keyword subset.
     *
     * <p>Integers follow JavaScript semantics: {@code 1.0} is an integer, and values beyond {@link
     * #MAX_SAFE_INTEGER} are rejected. {@code maxLength} counts code points as JSON Schema
     * requires.
     */
    private boolean matches(JsonObject schema, JsonElement value) {
        if (schema.has("const") && !schema.get("const").equals(value)) return false;
        if (schema.has("enum") && !schema.getAsJsonArray("enum").contains(value)) return false;
        // Reject another message kind before repeatedly checking its runtime IDs and version.
        if (value.isJsonObject() && schema.has("properties")) {
            JsonElement kind = value.getAsJsonObject().get("kind");
            JsonObject properties = schema.getAsJsonObject("properties");
            if (kind != null && properties.has("kind")) {
                JsonObject kindSchema = properties.getAsJsonObject("kind");
                if (kindSchema.has("const") && !kindSchema.get("const").equals(kind)) return false;
            }
        }
        if (schema.has("anyOf")) {
            boolean matched = false;
            for (JsonElement alternative : schema.getAsJsonArray("anyOf")) {
                if (matches(alternative.getAsJsonObject(), value)) {
                    matched = true;
                    break;
                }
            }
            if (!matched) return false;
        }

        // Type and numeric range checks.
        String type = schema.has("type") ? text(schema, "type") : "";
        JsonPrimitive primitive = value.isJsonPrimitive() ? value.getAsJsonPrimitive() : null;
        if (type.equals("object") && !value.isJsonObject()) return false;
        if (type.equals("array") && !value.isJsonArray()) return false;
        if (type.equals("string") && (primitive == null || !primitive.isString())) return false;
        if (type.equals("boolean") && (primitive == null || !primitive.isBoolean())) return false;
        if (type.equals("integer")) {
            if (primitive == null || !primitive.isNumber()) return false;
            double number = primitive.getAsDouble();
            if (!Double.isFinite(number)
                    || number % 1 != 0
                    || Math.abs(number) > MAX_SAFE_INTEGER) {
                return false;
            }
            if (schema.has("minimum") && number < schema.get("minimum").getAsDouble()) {
                return false;
            }
            if (schema.has("maximum") && number > schema.get("maximum").getAsDouble()) {
                return false;
            }
        }

        // Structural checks for the actual value shape.
        if (value.isJsonObject()) {
            JsonObject object = value.getAsJsonObject();
            JsonObject properties =
                    schema.has("properties")
                            ? schema.getAsJsonObject("properties")
                            : new JsonObject();
            if (schema.has("required")) {
                for (JsonElement key : schema.getAsJsonArray("required")) {
                    if (!object.has(key.getAsString())) return false;
                }
            }
            for (Map.Entry<String, JsonElement> entry : object.entrySet()) {
                if (properties.has(entry.getKey())) {
                    if (!matches(properties.getAsJsonObject(entry.getKey()), entry.getValue())) {
                        return false;
                    }
                } else if (schema.has("additionalProperties")
                        && !schema.get("additionalProperties").getAsBoolean()) {
                    return false;
                }
            }
        } else if (value.isJsonArray()) {
            JsonArray array = value.getAsJsonArray();
            if (schema.has("minItems") && array.size() < schema.get("minItems").getAsInt()) {
                return false;
            }
            if (schema.has("maxItems") && array.size() > schema.get("maxItems").getAsInt()) {
                return false;
            }
            Set<JsonElement> distinct = new HashSet<>();
            for (JsonElement item : array) {
                if (schema.has("uniqueItems")
                        && schema.get("uniqueItems").getAsBoolean()
                        && !distinct.add(item)) {
                    return false;
                }
                if (schema.has("items") && !matches(schema.getAsJsonObject("items"), item)) {
                    return false;
                }
            }
        } else if (primitive != null && primitive.isString()) {
            String text = primitive.getAsString();
            if (schema.has("maxLength")
                    && text.length() > schema.get("maxLength").getAsInt()
                    && text.codePointCount(0, text.length()) > schema.get("maxLength").getAsInt()) {
                return false;
            }
            if (schema.has("pattern")
                    && !patterns.get(text(schema, "pattern")).matcher(text).find()) {
                return false;
            }
        }
        return true;
    }

    /** Reads a string member that the schema has already required. */
    static String text(JsonObject value, String key) {
        return value.get(key).getAsString();
    }

    /**
     * Construct an internal envelope from alternating field names and JSON-compatible values.
     *
     * @throws IllegalArgumentException when the arguments are not pairs or a value is not a JSON
     *     element, string, number or boolean
     */
    static JsonObject object(Object... fields) {
        require(fields.length % 2 == 0, "Expected field/value pairs");
        JsonObject value = new JsonObject();
        for (int index = 0; index < fields.length; index += 2) {
            String key = (String) fields[index];
            Object item = fields[index + 1];
            if (item instanceof JsonElement) value.add(key, (JsonElement) item);
            else if (item instanceof String) value.addProperty(key, (String) item);
            else if (item instanceof Number) value.addProperty(key, (Number) item);
            else if (item instanceof Boolean) value.addProperty(key, (Boolean) item);
            else throw new IllegalArgumentException("Unsupported JSON field");
        }
        return value;
    }

    /** Throws {@link IllegalArgumentException} with {@code message} when the condition fails. */
    static void require(boolean condition, String message) {
        if (!condition) throw new IllegalArgumentException(message);
    }
}
