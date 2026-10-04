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

export type Infer<S> = S extends { readonly const: infer C }
  ? C
  : S extends { readonly enum: readonly (infer E)[] }
    ? E
    : S extends { readonly anyOf: readonly (infer V)[] }
      ? Infer<V>
      : S extends { readonly type: "string" }
        ? string
        : S extends { readonly type: "integer" }
          ? number
          : S extends { readonly type: "boolean" }
            ? boolean
            : S extends { readonly type: "array"; readonly items: infer I }
              ? Infer<I>[]
              : S extends {
                    readonly type: "object";
                    readonly properties: infer P;
                    readonly required: readonly (infer R)[];
                  }
                ? { [K in keyof P as K extends R ? K : never]: Infer<P[K]> } & {
                    [K in keyof P as K extends R ? never : K]?: Infer<P[K]>;
                  }
                : JsonValue;

export const MAX_MESSAGE_BYTES = 1_048_576;
export const MAX_JSON_DEPTH = 64;

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
  budget: { remaining: number },
): JsonValue {
  if (depth > MAX_JSON_DEPTH) invalid();
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    if (typeof value === "string" && value.length > budget.remaining) invalid();
    budget.remaining -= utf8Size(JSON.stringify(value));
    if (budget.remaining < 0) invalid();
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalid();
    budget.remaining -= JSON.stringify(value).length;
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
      if (key.length > budget.remaining) invalid();
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

function matches(schema: Schema, value: JsonValue): boolean {
  if ("const" in schema) return value === schema.const;
  if (schema.enum) return typeof value === "string" && schema.enum.includes(value);
  if (schema.anyOf) return schema.anyOf.some((option) => matches(option, value));
  switch (schema.type) {
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
        (!schema.uniqueItems || new Set(value).size === value.length) &&
        value.every((item) => matches(schema.items ?? {}, item))
      );
    case "string":
      return (
        typeof value === "string" &&
        [...value].length <= (schema.maxLength ?? Infinity) &&
        (!schema.pattern || new RegExp(schema.pattern).test(value))
      );
    case "integer":
      return (
        typeof value === "number" &&
        Number.isSafeInteger(value) &&
        value >= (schema.minimum ?? -Infinity) &&
        value <= (schema.maximum ?? Infinity)
      );
    case "boolean":
      return typeof value === "boolean";
    default:
      return true;
  }
}

export function validate<S extends Schema>(schema: S, value: unknown): Infer<S> {
  // Inspect descriptors once, then validate/serialize only the detached JSON
  // snapshot. Proxy traps must not leak diagnostics or alter the second read.
  try {
    const snapshot = snapshotJson(value, new Set(), 0, { remaining: MAX_MESSAGE_BYTES });
    if (!matches(schema, snapshot)) invalid();
    return snapshot as Infer<S>;
  } catch {
    invalid();
  }
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
  const snapshot = validate(schema, value);
  const text = JSON.stringify(snapshot);
  if (utf8Size(text) > MAX_MESSAGE_BYTES) invalid();
  return text;
}
