export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

// Only the keywords used by schema.ts are supported. Native consumers use the
// exported JSON Schema plus the transport limits described in protocol.md.
export type Schema = {
  readonly $schema?: string;
  readonly type?: "object" | "array" | "string" | "integer" | "boolean";
  readonly const?: string | number | boolean | null;
  readonly enum?: readonly string[];
  readonly anyOf?: readonly Schema[];
  readonly properties?: { readonly [key: string]: Schema };
  readonly required?: readonly string[];
  readonly additionalProperties?: false;
  readonly items?: Schema;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly uniqueItems?: boolean;
  readonly maxLength?: number;
  readonly pattern?: string;
};

type RequiredKeys<S> = S extends { readonly required: readonly string[] }
  ? S["required"][number]
  : never;

type ObjectProperties<S> = S extends { readonly properties: infer P } ? P : object;
// Exclude primitives and arrays without adding an index signature to closed shapes.
type InferObject<S, P = ObjectProperties<S>> = keyof P | RequiredKeys<S> extends never
  ? S extends { readonly additionalProperties: false }
    ? Record<string, never>
    : Record<string, JsonValue>
  : object & { [Symbol.iterator]?: never } & {
      [K in RequiredKeys<S>]: K extends keyof P
        ? Infer<P[K]>
        : S extends { readonly additionalProperties: false }
          ? never
          : JsonValue;
    } & {
      [K in keyof P as K extends RequiredKeys<S> ? never : K]?: Infer<P[K]>;
    };

// Without type, object keywords constrain only the object members of the inferred union.
type RefineObjects<S, V> = S extends { readonly type: string }
  ? V
  : S extends
        | { readonly properties: unknown }
        | { readonly required: readonly string[] }
        | { readonly additionalProperties: false }
    ? V extends object
      ? V extends readonly unknown[]
        ? V
        : V & InferObject<S>
      : V
    : V;

export type Infer<S> = RefineObjects<
  S,
  S extends { readonly anyOf: readonly (infer V)[] }
    ? InferShape<S> & Infer<V>
    : unknown extends InferShape<S>
      ? JsonValue
      : InferShape<S>
>;

// Without an outer shape, anyOf contributes only its branch union.
type InferShape<S> = S extends { readonly const: infer C }
  ? C
  : S extends { readonly enum: readonly (infer E)[] }
    ? E
    : S extends { readonly type: "string" }
      ? string
      : S extends { readonly type: "integer" }
        ? number
        : S extends { readonly type: "boolean" }
          ? boolean
          : S extends { readonly type: "array" }
            ? S extends { readonly items: infer I }
              ? Infer<I>[]
              : JsonValue[]
            : S extends { readonly type: "object" }
              ? InferObject<S>
              : unknown;

export const MAX_MESSAGE_BYTES = 1_048_576;
export const MAX_JSON_DEPTH = 64;
// Unicode mode matches lone UTF-16 surrogates, but leaves valid pairs intact.
const loneSurrogate = /[\uD800-\uDFFF]/u;

export class ProtocolError extends Error {
  constructor(
    public readonly code: "INVALID_ARGUMENT" | "UNSUPPORTED",
    message: string,
  ) {
    super(message);
    this.name = "ProtocolError";
  }
}

function invalid(): never {
  // Do not reflect raw payloads, parser diagnostics, or property names.
  throw new ProtocolError("INVALID_ARGUMENT", "Invalid protocol data.");
}

export function utf8Size(value: string): number {
  let size = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x80) size++;
    else if (code < 0x800) size += 2;
    else if (
      code >= 0xd800 &&
      code <= 0xdbff &&
      value.charCodeAt(i + 1) >= 0xdc00 &&
      value.charCodeAt(i + 1) <= 0xdfff
    ) {
      size += 4;
      i++;
    } else size += 3;
  }
  return size;
}

function snapshotJson(
  value: unknown,
  ancestors: Set<object>,
  depth: number,
  budget: { remaining: number; mode: "value" | "serialized" },
): JsonValue {
  if (depth > MAX_JSON_DEPTH) invalid();
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    if (typeof value === "string" && (value.length > budget.remaining || loneSurrogate.test(value)))
      invalid();
    budget.remaining -= utf8Size(JSON.stringify(value));
    if (budget.remaining < 0) invalid();
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalid();
    // Value validation charges the shortest possible number token to bound work
    // without imposing a reserialized byte limit on already received JSON.
    budget.remaining -= budget.mode === "serialized" ? JSON.stringify(value).length : 1;
    if (budget.remaining < 0) invalid();
    return value;
  }
  if (typeof value !== "object" || ancestors.has(value)) invalid();
  const array = Array.isArray(value);
  if (array && Object.getPrototypeOf(value) !== Array.prototype) invalid();
  if (
    !array &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  )
    invalid();
  ancestors.add(value);
  const keys = Reflect.ownKeys(value);
  const length = array ? value.length : 0;
  if (array && (!Number.isSafeInteger(length) || length < 0 || keys.length !== length + 1))
    invalid();
  budget.remaining -= 2; // {} or []
  const copy: JsonValue[] | { [key: string]: JsonValue } = array ? [] : Object.create(null);
  let first = true;
  for (const key of keys) {
    if (array && key === "length") continue;
    if (typeof key !== "string") invalid();
    if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length)) invalid();
    if (!first) budget.remaining--;
    first = false;
    if (!array) {
      if (key.length > budget.remaining || loneSurrogate.test(key)) invalid();
      budget.remaining -= utf8Size(JSON.stringify(key)) + 1;
    }
    if (budget.remaining < 0) invalid();
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (!property || !("value" in property) || !property.enumerable) invalid();
    const child = snapshotJson(property.value, ancestors, depth + 1, budget);
    if (Array.isArray(copy)) copy[Number(key)] = child;
    else copy[key] = child;
  }
  if (budget.remaining < 0) invalid();
  ancestors.delete(value);
  return copy;
}

// Object property order does not affect JSON equality; array order does.
function jsonKey(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(jsonKey).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${jsonKey(value[key] as JsonValue)}`)
    .join(",")}}`;
}

function matches(schema: Schema, value: JsonValue): boolean {
  if ("const" in schema && value !== schema.const) return false;
  if (schema.enum && (typeof value !== "string" || !schema.enum.includes(value))) return false;
  if (schema.anyOf && !schema.anyOf.some((option) => matches(option, value))) return false;
  // Keywords also apply without an explicit type (for example enum + maxLength).
  switch (
    schema.type ??
    (value === null ? "null" : Array.isArray(value) ? "array" : typeof value)
  ) {
    case "object": {
      if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
      const properties = schema.properties ?? {};
      return (
        (schema.required ?? []).every((key) => Object.hasOwn(value, key)) &&
        Object.entries(value).every(([key, item]) =>
          Object.hasOwn(properties, key)
            ? matches(properties[key] as Schema, item)
            : schema.additionalProperties !== false,
        )
      );
    }
    case "array":
      return (
        Array.isArray(value) &&
        value.length >= (schema.minItems ?? 0) &&
        value.length <= (schema.maxItems ?? Infinity) &&
        (!schema.uniqueItems || new Set(value.map(jsonKey)).size === value.length) &&
        value.every((item) => matches(schema.items ?? {}, item))
      );
    case "string":
      return (
        typeof value === "string" &&
        [...value].length <= (schema.maxLength ?? Infinity) &&
        (!schema.pattern || new RegExp(schema.pattern, "u").test(value))
      );
    case "integer":
    case "number":
      return (
        typeof value === "number" &&
        (schema.type !== "integer" || Number.isSafeInteger(value)) &&
        value >= (schema.minimum ?? -Infinity) &&
        value <= (schema.maximum ?? Infinity)
      );
    case "boolean":
      return typeof value === "boolean";
    default:
      return true;
  }
}

function checkedSnapshot<S extends Schema>(
  schema: S,
  value: unknown,
  mode: "value" | "serialized",
): Infer<S> {
  // Inspect descriptors once, then validate/serialize only the detached JSON
  // snapshot. Proxy traps must not leak diagnostics or alter the second read.
  try {
    const snapshot = snapshotJson(value, new Set(), 0, { remaining: MAX_MESSAGE_BYTES, mode });
    if (!matches(schema, snapshot)) invalid();
    return snapshot as Infer<S>;
  } catch {
    invalid();
  }
}

export function validate<S extends Schema>(schema: S, value: unknown): Infer<S> {
  return checkedSnapshot(schema, value, "value");
}

export function parse<S extends Schema>(schema: S, text: string): Infer<S> {
  if (typeof text !== "string" || utf8Size(text) > MAX_MESSAGE_BYTES) invalid();
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    invalid();
  }
  return validate(schema, value);
}

export function serialize<S extends Schema>(schema: S, value: unknown): string {
  const snapshot = checkedSnapshot(schema, value, "serialized");
  const text = JSON.stringify(snapshot);
  if (utf8Size(text) > MAX_MESSAGE_BYTES) invalid();
  return text;
}
