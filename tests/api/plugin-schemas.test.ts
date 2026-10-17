import { expect, test } from "bun:test";
import {
  base64CharactersFor,
  base64Schema,
  canonicalBase64Bytes,
  int32Schema,
  nonNegativeInt32Schema,
} from "@bunaway/plugin";
import { INT32_MAX, INT32_MIN } from "@bunaway/plugin-api/native";

test("base64Schema accepts canonical bounded base64 including the empty string", () => {
  const schema = base64Schema(6);
  for (const value of [
    "",
    "AA==",
    "AP8=",
    Buffer.from([
      0,
      1,
      128,
      255,
      7,
      9,
    ]).toString("base64"),
  ]) {
    expect(schema.safeParse(value).success).toBe(true);
  }
  expect(base64CharactersFor(6)).toBe(8);
  expect(base64CharactersFor(7)).toBe(12);
});

test("base64Schema rejects oversized, non-canonical, unpadded and foreign text", () => {
  const schema = base64Schema(6, "custom message");
  const rejected = [
    Buffer.alloc(7, 1).toString("base64"),
    // The unused bits of the final sextet must be zero.
    "AB==",
    "AAB=",
    "AAA",
    "AA=",
    "AA==\n",
    " AA==",
    "AA-_",
    "QQ==QQ==",
  ];
  for (const value of rejected) {
    expect(schema.safeParse(value).success).toBe(false);
  }
  const oversized = schema.safeParse(Buffer.alloc(7, 1).toString("base64"));
  expect(oversized.success).toBe(false);
  if (!oversized.success) {
    expect(oversized.error.issues.map((issue) => issue.message)).toContain(
      "custom message",
    );
  }
});

test("canonicalBase64Bytes reports decoded lengths and null for non-canonical padding", () => {
  expect(canonicalBase64Bytes("")).toBe(0);
  expect(canonicalBase64Bytes("AA==")).toBe(1);
  expect(canonicalBase64Bytes("AP8=")).toBe(2);
  expect(canonicalBase64Bytes("AAAA")).toBe(3);
  expect(canonicalBase64Bytes("AB==")).toBeNull();
  expect(canonicalBase64Bytes("AAB=")).toBeNull();
});

test("int32 schemas accept the signed 32-bit range and reject fractions and overflow", () => {
  for (const value of [
    INT32_MIN,
    -1,
    0,
    INT32_MAX,
  ]) {
    expect(int32Schema.safeParse(value).success).toBe(true);
  }
  for (const value of [
    INT32_MIN - 1,
    INT32_MAX + 1,
    1.5,
    Number.NaN,
    "1",
  ]) {
    expect(int32Schema.safeParse(value).success).toBe(false);
  }
  expect(nonNegativeInt32Schema.safeParse(0).success).toBe(true);
  expect(nonNegativeInt32Schema.safeParse(INT32_MAX).success).toBe(true);
  expect(nonNegativeInt32Schema.safeParse(-1).success).toBe(false);
});
