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

    /**
     * @throws IllegalArgumentException when the schema uses a keyword or type outside the supported
     *     subset
     */
    Protocol(JsonObject schema) {
        checkSchema(schema);
        this.schema = schema;
    }

    private static void checkSchema(JsonObject schema) {
        require(KEYWORDS.containsAll(schema.keySet()), "Unsupported schema keyword");
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
        require(
                text.getBytes(StandardCharsets.UTF_8).length <= MAX_MESSAGE_BYTES,
                "Message too large");
        // Bound nesting before the parser allocates an attacker-controlled tree.
        int depth = 0;
        boolean quoted = false;
        boolean escaped = false;
        for (int index = 0; index < text.length(); index++) {
            char character = text.charAt(index);
            if (quoted) {
                if (escaped) escaped = false;
                else if (character == '\\') escaped = true;
                else if (character == '"') quoted = false;
            } else if (character == '"') quoted = true;
            else if (character == '{' || character == '[') {
                require(++depth <= MAX_JSON_DEPTH + 1, "JSON nesting too deep");
            } else if (character == '}' || character == ']') depth--;
        }
        JsonObject value = readObject(text);
        require(matches(schema, value), "Invalid protocol message");
        return value;
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
        require(
                text.getBytes(StandardCharsets.UTF_8).length <= MAX_MESSAGE_BYTES,
                "Message too large");
        return text;
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
    private static void checkDepth(JsonElement value, int depth) {
        require(depth <= MAX_JSON_DEPTH, "JSON nesting too deep");
        if (value.isJsonObject()) {
            for (Map.Entry<String, JsonElement> entry : value.getAsJsonObject().entrySet()) {
                // Object keys are strings too, so check their Unicode with the same rule.
                checkDepth(new JsonPrimitive(entry.getKey()), depth + 1);
                checkDepth(entry.getValue(), depth + 1);
            }
        } else if (value.isJsonArray()) {
            for (JsonElement item : value.getAsJsonArray()) checkDepth(item, depth + 1);
        } else if (value.isJsonPrimitive()) {
            JsonPrimitive primitive = value.getAsJsonPrimitive();
            if (primitive.isNumber()) {
                require(Double.isFinite(primitive.getAsDouble()), "Non-finite JSON number");
            }
            String text = primitive.getAsString();
            for (int index = 0; index < text.length(); index++) {
                char character = text.charAt(index);
                if (Character.isHighSurrogate(character)) {
                    require(
                            ++index < text.length() && Character.isLowSurrogate(text.charAt(index)),
                            "Invalid Unicode");
                } else require(!Character.isLowSurrogate(character), "Invalid Unicode");
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
    private static boolean matches(JsonObject schema, JsonElement value) {
        if (schema.has("const") && !schema.get("const").equals(value)) return false;
        if (schema.has("enum") && !schema.getAsJsonArray("enum").contains(value)) return false;
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
                    && text.codePointCount(0, text.length()) > schema.get("maxLength").getAsInt()) {
                return false;
            }
            if (schema.has("pattern")
                    && !Pattern.compile(text(schema, "pattern")).matcher(text).find()) {
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
