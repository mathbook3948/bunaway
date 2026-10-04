import { hostOperations, type JsonValue, type Schema } from "../../packages/protocol/src/index.ts";

// The same inputs exercise TypeScript and the actual Windows IPC validator.
export const validationCases: {
  name: string;
  schema: Schema;
  value: JsonValue;
  accepted: boolean;
}[] = [
  { name: "empty schema accepts null", schema: {}, value: null, accepted: true },
  {
    name: "const with length",
    schema: { const: "long", maxLength: 2 },
    value: "long",
    accepted: false,
  },
  {
    name: "const with pattern",
    schema: { const: "a", pattern: "^b$" },
    value: "a",
    accepted: false,
  },
  { name: "const with type", schema: { const: 1, type: "string" }, value: 1, accepted: false },
  { name: "const with bounds", schema: { const: 1, minimum: 2 }, value: 1, accepted: false },
  {
    name: "enum with length",
    schema: { enum: ["long"], maxLength: 2 },
    value: "long",
    accepted: false,
  },
  {
    name: "enum with pattern",
    schema: { enum: ["a"], pattern: "^b$" },
    value: "a",
    accepted: false,
  },
  { name: "enum with type", schema: { enum: ["a"], type: "integer" }, value: "a", accepted: false },
  {
    name: "matching combined constraints",
    schema: { const: "a", enum: ["a"], anyOf: [{ type: "string" }], maxLength: 1, pattern: "^a$" },
    value: "a",
    accepted: true,
  },
  {
    name: "anyOf with outer length",
    schema: { anyOf: [{ const: "long" }, { const: "a" }], maxLength: 2 },
    value: "long",
    accepted: false,
  },
  {
    name: "anyOf with outer pattern",
    schema: { anyOf: [{ type: "string" }], pattern: "^b$" },
    value: "a",
    accepted: false,
  },
  {
    name: "anyOf with outer type",
    schema: { anyOf: [{ const: 1 }], type: "string" },
    value: 1,
    accepted: false,
  },
  {
    name: "anyOf no match",
    schema: { anyOf: [{ const: "a" }, { const: "b" }] },
    value: "c",
    accepted: false,
  },
  {
    name: "outer properties without type",
    schema: { anyOf: [{ type: "object" }], required: ["id"] },
    value: {},
    accepted: false,
  },
  {
    name: "duplicate objects",
    schema: { type: "array", uniqueItems: true },
    value: [{ id: 1 }, { id: 1 }],
    accepted: false,
  },
  {
    name: "object key order is irrelevant",
    schema: { uniqueItems: true },
    value: [
      { a: 1, b: [2] },
      { b: [2], a: 1 },
    ],
    accepted: false,
  },
  {
    name: "duplicate nested arrays",
    schema: { type: "array", uniqueItems: true },
    value: [[{ id: 1 }], [{ id: 1 }]],
    accepted: false,
  },
  {
    name: "array order is significant",
    schema: { type: "array", uniqueItems: true },
    value: [
      [1, 2],
      [2, 1],
    ],
    accepted: true,
  },
  {
    name: "distinct objects",
    schema: { type: "array", uniqueItems: true },
    value: [{ id: 1 }, { id: 2 }],
    accepted: true,
  },
  {
    name: "mixed JSON types are distinct",
    schema: { type: "array", uniqueItems: true },
    value: [1, "1", null, false, {}, []],
    accepted: true,
  },
  {
    name: "duplicates allowed without uniqueItems",
    schema: { type: "array" },
    value: [{ id: 1 }, { id: 1 }],
    accepted: true,
  },
  {
    name: "600 astral code points",
    schema: { type: "string", maxLength: 1024 },
    value: "😀".repeat(600),
    accepted: true,
  },
  {
    name: "1024 astral code points",
    schema: { type: "string", maxLength: 1024 },
    value: "😀".repeat(1024),
    accepted: true,
  },
  {
    name: "1025 astral code points",
    schema: { type: "string", maxLength: 1024 },
    value: "😀".repeat(1025),
    accepted: false,
  },
  {
    name: "combining marks count separately",
    schema: { type: "string", maxLength: 1 },
    value: "e\u0301",
    accepted: false,
  },
];

export const combinedSchema = {
  type: "object",
  properties: { base: { type: "string" }, note: { type: "string" } },
  required: ["base"],
  anyOf: [
    {
      type: "object",
      properties: { kind: { const: "a" }, value: { type: "string" } },
      required: ["kind", "value"],
    },
    {
      type: "object",
      properties: { kind: { const: "b" }, value: { type: "integer" } },
      required: ["kind", "value"],
    },
  ],
} as const;
export const implicitObjectSchema = {
  properties: { id: { type: "string" } },
  required: ["id"],
  anyOf: [
    { type: "object", properties: { kind: { const: "a" } }, required: ["kind"] },
    { type: "object", properties: { kind: { const: "b" } }, required: ["kind"] },
  ],
} as const;
export const implicitMixedSchema = {
  properties: implicitObjectSchema.properties,
  required: implicitObjectSchema.required,
  anyOf: [implicitObjectSchema.anyOf[0], { const: null }],
} as const;
export const implicitRequiredSchema = {
  required: ["id"],
  anyOf: implicitObjectSchema.anyOf,
} as const;
validationCases.push(
  {
    name: "implicit required without properties accepts JSON value",
    schema: implicitRequiredSchema,
    value: { id: 42, kind: "a" },
    accepted: true,
  },
  {
    name: "implicit required without properties rejects missing key",
    schema: implicitRequiredSchema,
    value: { kind: "a" },
    accepted: false,
  },
  {
    name: "implicit object keywords leave arrays unconstrained",
    schema: { properties: { id: { type: "string" } }, required: ["id"] },
    value: [42],
    accepted: true,
  },
  {
    name: "implicit outer object valid branch a",
    schema: implicitObjectSchema,
    value: { id: "root", kind: "a" },
    accepted: true,
  },
  {
    name: "implicit outer object valid branch b",
    schema: implicitObjectSchema,
    value: { id: "root", kind: "b" },
    accepted: true,
  },
  {
    name: "implicit outer object missing required id",
    schema: implicitObjectSchema,
    value: { kind: "a" },
    accepted: false,
  },
  {
    name: "implicit outer object wrong id type",
    schema: implicitObjectSchema,
    value: { id: 42, kind: "a" },
    accepted: false,
  },
  {
    name: "implicit object constraints allow non-object branch",
    schema: implicitMixedSchema,
    value: null,
    accepted: true,
  },
);
validationCases.push(
  {
    name: "anyOf with common required field branch a",
    schema: combinedSchema,
    value: { base: "root", kind: "a", value: "text" },
    accepted: true,
  },
  {
    name: "anyOf with common required field branch b",
    schema: combinedSchema,
    value: { base: "root", kind: "b", value: 42 },
    accepted: true,
  },
  {
    name: "anyOf missing common required field",
    schema: combinedSchema,
    value: { kind: "a", value: "text" },
    accepted: false,
  },
  {
    name: "anyOf wrong common field type",
    schema: combinedSchema,
    value: { base: 42, kind: "a", value: "text" },
    accepted: false,
  },
);

const malformedUnicode: [string, JsonValue][] = [
  ["lone high surrogate", "\uD800"],
  ["lone low surrogate", "\uDFFF"],
  ["reversed surrogate pair", "\uDC00\uD800"],
  ["high surrogate before BMP", "\uD800a"],
  ["low surrogate after BMP", "a\uDC00"],
  ["sliced emoji", "😀".slice(0, 1)],
  ["nested surrogate value", { nested: ["\uD800"] }],
  ["surrogate object key", { "\uD800": "value" }],
  ["nested surrogate key", { nested: { "\uDC00": null } }],
];
for (const [name, value] of malformedUnicode) {
  validationCases.push({ name, schema: {}, value, accepted: false });
}

validationCases.push(
  { name: "empty string", schema: {}, value: "", accepted: true },
  { name: "BMP surrogate boundaries", schema: {}, value: "\uD7FF\uE000", accepted: true },
  {
    name: "valid surrogate pairs in key and value",
    schema: {},
    value: { "\uD800\uDC00": "\uDBFF\uDFFF" },
    accepted: true,
  },
  {
    name: "omitted required accepts empty object",
    schema: { type: "object", properties: { note: { type: "string" } } },
    value: {},
    accepted: true,
  },
  {
    name: "omitted required validates present property",
    schema: { type: "object", properties: { note: { type: "string" } } },
    value: { note: 42 },
    accepted: false,
  },
);

for (const [path, accepted] of [
  ["notes\u2028/../escape", false],
  ["notes\u2029/../escape", false],
  ["notes\u2028/./escape", false],
  ["notes\u2029/./escape", false],
  ["notes/../\u2028escape", false],
  ["notes/./\u2029escape", false],
  ["notes\u2028/file.txt", true],
  ["notes\u2029/file.txt", true],
] as const) {
  validationCases.push({
    name: `Unicode path ${JSON.stringify(path)}`,
    schema: hostOperations["storage.readText"].input,
    value: { scope: "appData", path },
    accepted,
  });
}
