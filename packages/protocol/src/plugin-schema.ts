import { z } from "zod";
import type { Schema, TypedSchema } from "./validation.ts";

const PLUGIN_SCHEMA_KEYWORDS = new Set([
  "$schema",
  "$ref",
  "$defs",
  "type",
  "const",
  "enum",
  "anyOf",
  "properties",
  "required",
  "additionalProperties",
  "propertyNames",
  "items",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minLength",
  "maxLength",
  "pattern",
  "x-bunaway-stripUnknown",
]);

/**
 * Convert a plugin's Zod declaration to a portable JSON Schema contract.
 * Carries Zod's object stripping rule alongside JSON Schema validation so every
 * execution boundary produces the same value without running author code.
 */
export function toJSONSchema<S extends z.ZodType>(
  schema: S,
): TypedSchema<z.output<S>> {
  if (
    [
      "optional",
      "exact_optional",
    ].includes(schema._zod.def.type)
  ) {
    throw new Error("Optional plugin schemas must be object fields.");
  }
  const json = z.toJSONSchema(schema, {
    target: "draft-2020-12",
    io: "input",
    // Annotation metadata must not replace the schema's validation keywords.
    metadata: z.registry(),
    unrepresentable: "throw",
    override({ zodSchema, jsonSchema }) {
      const definition = zodSchema._zod.def;
      // Zod conversion can omit custom checks; only shared, value-preserving checks are allowed.
      if (
        ("coerce" in definition && definition.coerce) ||
        [
          "default",
          "prefault",
          "catch",
          "pipe",
          "transform",
          "readonly",
        ].includes(definition.type) ||
        definition.checks?.some(
          (check) =>
            ![
              "greater_than",
              "less_than",
              "multiple_of",
              "number_format",
              "min_length",
              "max_length",
              "length_equals",
              "string_format",
            ].includes(check._zod.def.check),
        )
      ) {
        throw new Error(
          "Plugin schemas cannot transform values or contain custom checks.",
        );
      }
      if (definition.type === "object") {
        if (!definition.catchall) {
          Object.assign(jsonSchema, {
            "x-bunaway-stripUnknown": true,
          });
        } else if (definition.catchall._zod.def.type !== "never") {
          throw new Error(
            "Plugin object schemas must use z.object() or z.strictObject().",
          );
        }
      }
      for (const check of definition.checks ?? []) {
        if (
          check._zod.def.check === "string_format" &&
          "pattern" in check._zod.def
        ) {
          const pattern = check._zod.def.pattern;
          if (pattern instanceof RegExp && pattern.flags !== "u") {
            throw new Error(
              "Plugin regular expressions must use only the Unicode flag.",
            );
          }
        }
      }
    },
  });
  // Conversion is checked again by registration. This assertion carries only
  // the source schema's inferred type; it does not trust external JSON contracts.
  // Zod attaches a non-enumerable Standard Schema adapter containing functions.
  // Only the JSON document may cross a process or Worker boundary.
  const portable: Schema = JSON.parse(JSON.stringify(json));
  checkPluginSchema(portable);
  return portable as TypedSchema<z.output<S>>;
}

/** Rejects JSON Schema keywords whose validation is not part of the plugin contract. */
export function checkPluginSchema(schema: Schema, root = schema): void {
  if (
    !schema ||
    typeof schema !== "object" ||
    Array.isArray(schema) ||
    Object.keys(schema).some((key) => !PLUGIN_SCHEMA_KEYWORDS.has(key))
  ) {
    throw new Error("Unsupported plugin JSON Schema keyword.");
  }
  const types =
    typeof schema.type === "string"
      ? [
          schema.type,
        ]
      : (schema.type ?? []);
  if (
    !Array.isArray(types) ||
    types.some(
      (type) =>
        ![
          "object",
          "array",
          "string",
          "integer",
          "number",
          "boolean",
          "null",
        ].includes(type),
    ) ||
    (schema.type !== undefined && !types.length)
  ) {
    invalidSchema("Invalid plugin schema type.");
  }
  if (schema.$ref !== undefined && !resolveSchemaReference(schema.$ref, root)) {
    invalidSchema("Invalid plugin schema reference.");
  }
  if (
    schema["x-bunaway-stripUnknown"] !== undefined &&
    (schema["x-bunaway-stripUnknown"] !== true ||
      schema.type !== "object" ||
      schema.additionalProperties !== undefined)
  ) {
    invalidSchema("Invalid plugin object stripping rule.");
  }
  if (
    schema.const !== undefined &&
    schema.const !== null &&
    ![
      "string",
      "number",
      "boolean",
    ].includes(typeof schema.const)
  ) {
    invalidSchema("Invalid plugin schema constant.");
  }
  if (schema.$schema !== undefined && typeof schema.$schema !== "string") {
    invalidSchema("Invalid plugin schema identifier.");
  }
  if (
    schema.items !== undefined &&
    (!schema.items ||
      typeof schema.items !== "object" ||
      Array.isArray(schema.items))
  ) {
    invalidSchema("Invalid plugin item schema.");
  }
  if (
    schema.additionalProperties !== undefined &&
    typeof schema.additionalProperties !== "boolean" &&
    (!schema.additionalProperties ||
      typeof schema.additionalProperties !== "object" ||
      Array.isArray(schema.additionalProperties))
  ) {
    invalidSchema("Invalid plugin object schema.");
  }
  for (const list of [
    schema.enum,
    schema.required,
  ]) {
    if (
      list !== undefined &&
      (!Array.isArray(list) ||
        list.some((value) =>
          list === schema.required
            ? typeof value !== "string"
            : value !== null &&
              ![
                "string",
                "number",
                "boolean",
              ].includes(typeof value),
        ))
    ) {
      invalidSchema("Invalid plugin schema list.");
    }
  }
  for (const count of [
    schema.minItems,
    schema.maxItems,
    schema.maxLength,
    schema.minLength,
  ]) {
    if (count !== undefined && (!Number.isSafeInteger(count) || count < 0)) {
      invalidSchema("Invalid plugin schema limit.");
    }
  }
  for (const number of [
    schema.minimum,
    schema.maximum,
    schema.exclusiveMinimum,
    schema.exclusiveMaximum,
    schema.multipleOf,
  ]) {
    if (
      number !== undefined &&
      (typeof number !== "number" || !Number.isFinite(number))
    ) {
      invalidSchema("Invalid plugin schema bound.");
    }
  }
  if (schema.multipleOf !== undefined && schema.multipleOf <= 0) {
    invalidSchema("Invalid plugin schema multiple.");
  }
  if (
    schema.uniqueItems !== undefined &&
    typeof schema.uniqueItems !== "boolean"
  ) {
    invalidSchema("Invalid plugin schema uniqueness.");
  }
  if (schema.pattern !== undefined) {
    if (typeof schema.pattern !== "string") {
      invalidSchema("Invalid plugin schema pattern.");
    }
    try {
      new RegExp(schema.pattern, "u");
    } catch {
      invalidSchema("Invalid plugin schema pattern.");
    }
  }
  for (const map of [
    schema.properties,
    schema.$defs,
  ]) {
    if (
      map !== undefined &&
      (!map || typeof map !== "object" || Array.isArray(map))
    ) {
      invalidSchema("Invalid plugin schema properties.");
    }
  }
  if (
    schema.propertyNames !== undefined &&
    (!schema.propertyNames ||
      typeof schema.propertyNames !== "object" ||
      Array.isArray(schema.propertyNames))
  ) {
    invalidSchema("Invalid plugin property name schema.");
  }
  if (
    schema.anyOf !== undefined &&
    (!Array.isArray(schema.anyOf) || !schema.anyOf.length)
  ) {
    invalidSchema("Invalid plugin schema alternatives.");
  }
  for (const child of [
    ...Object.values(schema.properties ?? {}),
    ...Object.values(schema.$defs ?? {}),
    ...(schema.propertyNames
      ? [
          schema.propertyNames,
        ]
      : []),
    ...(typeof schema.additionalProperties === "object" &&
    schema.additionalProperties
      ? [
          schema.additionalProperties,
        ]
      : []),
    ...(schema.anyOf ?? []),
    ...(schema.items
      ? [
          schema.items,
        ]
      : []),
  ]) {
    checkPluginSchema(child, root);
  }
}

/** Resolve a local JSON Pointer without following inherited properties or external resources. */
export function resolveSchemaReference(
  reference: string,
  root: Schema,
): Schema | undefined {
  if (reference === "#") {
    return root;
  }
  if (!reference.startsWith("#/")) {
    return undefined;
  }
  let target: unknown = root;
  for (const token of reference.slice(2).split("/")) {
    const key = token.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!target || typeof target !== "object" || !Object.hasOwn(target, key)) {
      return undefined;
    }
    target = Reflect.get(target, key);
  }
  return target && typeof target === "object" && !Array.isArray(target)
    ? (target as Schema)
    : undefined;
}

function invalidSchema(message: string): never {
  throw new Error(message);
}
