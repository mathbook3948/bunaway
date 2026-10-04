import type { JsonValue, Schema } from "../../packages/protocol/src/index.ts";

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
