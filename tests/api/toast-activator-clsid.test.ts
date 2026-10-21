import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { toastActivatorClsid, uuidV5 } from "#protocol/toast-activator-clsid";

const DNS_NAMESPACE = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

/** Reference name-based UUID version 5 from the platform digest. */
function referenceUuidV5(namespace: string, name: string): string {
  const bytes = createHash("sha1")
    .update(Buffer.from(namespace.replaceAll("-", ""), "hex"))
    .update(name)
    .digest()
    .subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const text = bytes.toString("hex");
  return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`;
}

test("uuidV5 matches the RFC 4122 example", () => {
  expect(uuidV5(DNS_NAMESPACE, "python.org")).toBe(
    "886313e1-3b8a-5372-9b90-0c9aee199e5d",
  );
});

test("uuidV5 matches the platform digest across padding boundaries", () => {
  // Lengths around the padding boundary (namespace adds 16 bytes) and the 64 byte block size.
  for (const length of [
    0,
    1,
    20,
    39,
    40,
    47,
    48,
    55,
    56,
    63,
    64,
    119,
    200,
  ]) {
    const name = "a".repeat(length);
    expect(uuidV5(DNS_NAMESPACE, name)).toBe(
      referenceUuidV5(DNS_NAMESPACE, name),
    );
  }
});

test("uuidV5 encodes non-ASCII names as UTF-8", () => {
  for (const name of [
    "앱",
    "é.app",
    "a😀b",
  ]) {
    expect(uuidV5(DNS_NAMESPACE, name)).toBe(
      referenceUuidV5(DNS_NAMESPACE, name),
    );
  }
});

test("the toast activator CLSID is stable, per app and a version 5 UUID", () => {
  const clsid = toastActivatorClsid("com.example.app");
  expect(clsid).toBe(toastActivatorClsid("com.example.app"));
  expect(clsid).not.toBe(toastActivatorClsid("com.example.other"));
  expect(clsid).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
});
