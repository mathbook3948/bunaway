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

const SHARED_SCHEMA_CHECKS = new Set([
  "greater_than",
  "less_than",
  "multiple_of",
  "number_format",
  "min_length",
  "max_length",
  "length_equals",
  "string_format",
]);

/** Reject checks that cannot be enforced from their serialized constraints. */
function checkSharedCheck(check: z.core.$ZodCheck): void {
  const definition = check._zod.def;
  if (
    !SHARED_SCHEMA_CHECKS.has(definition.check) ||
    (definition.check === "string_format" &&
      "fn" in definition &&
      !("pattern" in definition && definition.pattern instanceof RegExp))
  ) {
    throw new Error(
      "Plugin schemas cannot transform values or contain custom checks.",
    );
  }
  if (definition.check === "string_format" && "pattern" in definition) {
    const pattern = definition.pattern;
    if (pattern instanceof RegExp && pattern.flags !== "u") {
      throw new Error(
        "Plugin regular expressions must use only the Unicode flag.",
      );
    }
  }
}

/** Rejects literals that JSON would change or discard during serialization. */
function checkSchemaLiteral(value: unknown): void {
  if (
    value !== null &&
    typeof value !== "string" &&
    typeof value !== "boolean" &&
    !(typeof value === "number" && Number.isFinite(value))
  ) {
    throw new Error("Plugin schema literals must be finite JSON values.");
  }
}

/**
 * Checks the source graph before conversion can discard flags, modes or checks.
 * Only the pinned Zod kinds below are supported; unknown kinds fail closed.
 */
function checkSourceSchema(root: z.core.$ZodType): void {
  // A schema reused as a value must still be checked under record-key rules.
  const values = new Set<z.core.$ZodType>();
  const keys = new Set<z.core.$ZodType>();
  const visit = (schema: z.core.$ZodType, recordKey = false): void => {
    const seen = recordKey ? keys : values;
    if (seen.has(schema)) {
      return;
    }
    seen.add(schema);
    // Zod exposes child schemas as $ZodType; its built-in kind discriminates
    // their definitions. The default branch rejects unrecognized kinds.
    const definition = (schema as z.core.$ZodTypes)._zod.def;
    if ("coerce" in definition && definition.coerce) {
      throw new Error(
        "Plugin schemas cannot transform values or contain custom checks.",
      );
    }
    if (schema instanceof z.core.$ZodCheck) {
      checkSharedCheck(schema);
    }
    for (const check of definition.checks ?? []) {
      checkSharedCheck(check);
    }
    switch (definition.type) {
      case "number":
        if (recordKey) {
          throw new Error("Plugin record keys cannot use numeric schemas.");
        }
        return;
      case "string":
      case "boolean":
      case "null":
      case "any":
      case "unknown":
        return;
      case "literal":
        for (const value of definition.values) {
          checkSchemaLiteral(value);
        }
        return;
      case "enum":
        for (const value of Object.values(definition.entries)) {
          checkSchemaLiteral(value);
        }
        return;
      case "object":
        if (
          definition.catchall &&
          definition.catchall._zod.def.type !== "never"
        ) {
          throw new Error(
            "Plugin object schemas must use z.object() or z.strictObject().",
          );
        }
        for (const child of Object.values(definition.shape)) {
          visit(child);
        }
        return;
      case "array":
        visit(definition.element);
        return;
      case "tuple":
        for (const child of definition.items) {
          visit(child);
        }
        if (definition.rest) {
          visit(definition.rest);
        }
        return;
      case "record":
        if (definition.mode !== undefined && definition.mode !== "strict") {
          throw new Error("Plugin record schemas cannot use loose mode.");
        }
        visit(definition.keyType, true);
        visit(definition.valueType);
        return;
      case "union":
        for (const child of definition.options) {
          visit(child, recordKey);
        }
        return;
      case "intersection":
        visit(definition.left, recordKey);
        visit(definition.right, recordKey);
        return;
      case "optional":
      case "nonoptional":
      case "nullable":
        visit(definition.innerType, recordKey);
        return;
      case "lazy":
        // Use Zod's cached resolution so checking and conversion see one graph.
        visit((schema as z.core.$ZodLazy)._zod.innerType, recordKey);
        return;
      default:
        throw new Error(`Unsupported plugin schema type: ${definition.type}.`);
    }
  };
  visit(root);
}

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
  checkSourceSchema(schema);
  const json = z.toJSONSchema(schema, {
    target: "draft-2020-12",
    // Output mode preserves exhaustive record keys. Value transformations are
    // rejected before conversion, so input and output share the same JSON constraints.
    io: "output",
    // Annotation metadata must not replace the schema's validation keywords.
    metadata: z.registry(),
    unrepresentable: "throw",
    override({ zodSchema, jsonSchema }) {
      const definition = zodSchema._zod.def;
      if (definition.type === "object") {
        if (!definition.catchall) {
          // Ordinary objects strip extra fields instead of rejecting them.
          delete jsonSchema.additionalProperties;
          Object.assign(jsonSchema, {
            "x-bunaway-stripUnknown": true,
          });
        }
      }
    },
  });
  // Validate before JSON.stringify can turn non-finite constants into null.
  checkPluginSchema(json);
  // Omit Zod's non-enumerable Standard Schema adapter, which contains functions.
  const portable: Schema = JSON.parse(JSON.stringify(json));
  // Only the source's inferred output type is asserted; registration rechecks contracts.
  return portable as TypedSchema<z.output<S>>;
}

/** Checks generated or received contracts before their constraints can be trusted. */
export function checkPluginSchema(
  schema: unknown,
  root = schema,
): asserts schema is Schema {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    invalidSchema("Invalid plugin schema object.");
  }
  // The object boundary is checked; every indexed field remains unknown until validated.
  const contract = schema as Record<string, unknown>;
  if (Object.keys(contract).some((key) => !PLUGIN_SCHEMA_KEYWORDS.has(key))) {
    invalidSchema("Unsupported plugin JSON Schema keyword.");
  }
  const types =
    typeof contract.type === "string"
      ? [
          contract.type,
        ]
      : (contract.type ?? []);
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
    (contract.type !== undefined && !types.length)
  ) {
    invalidSchema("Invalid plugin schema type.");
  }
  if (
    contract.$ref !== undefined &&
    (typeof contract.$ref !== "string" ||
      !resolveSchemaReference(contract.$ref, root))
  ) {
    invalidSchema("Invalid plugin schema reference.");
  }
  if (
    contract["x-bunaway-stripUnknown"] !== undefined &&
    (contract["x-bunaway-stripUnknown"] !== true ||
      contract.type !== "object" ||
      contract.additionalProperties !== undefined)
  ) {
    invalidSchema("Invalid plugin object stripping rule.");
  }
  if (Object.hasOwn(contract, "const")) {
    checkSchemaLiteral(contract.const);
  }
  if (contract.$schema !== undefined && typeof contract.$schema !== "string") {
    invalidSchema("Invalid plugin schema identifier.");
  }
  if (contract.enum !== undefined) {
    if (!Array.isArray(contract.enum)) {
      invalidSchema("Invalid plugin schema list.");
    }
    for (const value of contract.enum) {
      checkSchemaLiteral(value);
    }
  }
  if (
    contract.required !== undefined &&
    (!Array.isArray(contract.required) ||
      contract.required.some((value) => typeof value !== "string"))
  ) {
    invalidSchema("Invalid plugin schema list.");
  }
  for (const count of [
    contract.minItems,
    contract.maxItems,
    contract.maxLength,
    contract.minLength,
  ]) {
    if (
      count !== undefined &&
      (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0)
    ) {
      invalidSchema("Invalid plugin schema limit.");
    }
  }
  for (const number of [
    contract.minimum,
    contract.maximum,
    contract.exclusiveMinimum,
    contract.exclusiveMaximum,
    contract.multipleOf,
  ]) {
    if (
      number !== undefined &&
      (typeof number !== "number" || !Number.isFinite(number))
    ) {
      invalidSchema("Invalid plugin schema bound.");
    }
  }
  if (typeof contract.multipleOf === "number" && contract.multipleOf <= 0) {
    invalidSchema("Invalid plugin schema multiple.");
  }
  if (
    contract.uniqueItems !== undefined &&
    typeof contract.uniqueItems !== "boolean"
  ) {
    invalidSchema("Invalid plugin schema uniqueness.");
  }
  if (contract.pattern !== undefined) {
    if (typeof contract.pattern !== "string") {
      invalidSchema("Invalid plugin schema pattern.");
    }
    try {
      new RegExp(contract.pattern, "u");
    } catch {
      invalidSchema("Invalid plugin schema pattern.");
    }
  }
  for (const map of [
    contract.properties,
    contract.$defs,
  ]) {
    if (map === undefined) {
      continue;
    }
    if (!map || typeof map !== "object" || Array.isArray(map)) {
      invalidSchema("Invalid plugin schema properties.");
    }
    for (const child of Object.values(map)) {
      checkPluginSchema(child, root);
    }
  }
  if (contract.anyOf !== undefined) {
    if (!Array.isArray(contract.anyOf) || !contract.anyOf.length) {
      invalidSchema("Invalid plugin schema alternatives.");
    }
    for (const child of contract.anyOf) {
      checkPluginSchema(child, root);
    }
  }
  for (const child of [
    contract.items,
    contract.propertyNames,
  ]) {
    if (child !== undefined) {
      checkPluginSchema(child, root);
    }
  }
  if (
    contract.additionalProperties !== undefined &&
    typeof contract.additionalProperties !== "boolean"
  ) {
    checkPluginSchema(contract.additionalProperties, root);
  }
}

/** Resolve a local JSON Pointer without following inherited properties or external resources. */
export function resolveSchemaReference(
  reference: string,
  root: unknown,
): Schema | undefined {
  if (reference !== "#" && !reference.startsWith("#/")) {
    return undefined;
  }
  let target: unknown = root;
  const tokens = reference === "#" ? [] : reference.slice(2).split("/");
  for (const token of tokens) {
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
