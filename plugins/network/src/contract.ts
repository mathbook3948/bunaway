import { z } from "zod";
/** Transport limits leave space for protocol envelopes and base64 expansion. */
export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_HEADER_BYTES = 16 * 1024;
export const MAX_NETWORK_TIMEOUT_MS = 30_000;
const MAX_BASE64_CHARS = Math.ceil(MAX_BODY_BYTES / 3) * 4;
const base64 = z
  .string()
  .max(MAX_BASE64_CHARS)
  .regex(
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$(?![\s\S])/,
  )
  .refine((value) => {
    const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
    return (value.length / 4) * 3 - padding <= MAX_BODY_BYTES;
  }, "Body exceeds the byte limit.");
const header = z.tuple([
  z
    .string()
    .min(1)
    .max(256)
    .regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$(?![\s\S])/),
  z
    .string()
    .max(4096)
    .regex(/^[\t\x20-\x7e\x80-\xff]*$(?![\s\S])/),
]);
const headers = z
  .array(header)
  .max(64)
  .refine(
    (values) =>
      values.reduce(
        (bytes, [name, value]) => bytes + name.length + value.length,
        0,
      ) <= MAX_HEADER_BYTES,
    "Headers exceed the byte limit.",
  );
const requestHeaders = headers.refine(
  (values) =>
    values.every(([name]) => {
      const lower = name.toLowerCase();
      return (
        ![
          "host",
          "content-length",
          "connection",
          "transfer-encoding",
          "upgrade",
          "proxy-authorization",
          "proxy-connection",
          "origin",
          "referer",
          "cookie",
          "accept-encoding",
          "expect",
        ].includes(lower) && !lower.startsWith("sec-")
      );
    }),
  "Transport-managed header.",
);
function urlFor(protocols: string[]) {
  return z
    .string()
    .min(1)
    .max(8192)
    .refine((value) => {
      if (
        Array.from(value).some(
          (char) =>
            char.charCodeAt(0) <= 0x20 ||
            char.charCodeAt(0) === 0x7f ||
            char === "\\",
        )
      ) {
        return false;
      }
      try {
        const url = new URL(value);
        return (
          protocols.includes(url.protocol) &&
          !!url.hostname &&
          !url.username &&
          !url.password &&
          !url.hash
        );
      } catch {
        return false;
      }
    }, "Expected an absolute network URL without credentials or fragment.");
}
const timeoutMs = z
  .number()
  .int()
  .min(1)
  .max(MAX_NETWORK_TIMEOUT_MS)
  .default(MAX_NETWORK_TIMEOUT_MS);
/** Bounded network calls owned by one cancellable host invocation, without persistent handles. */
export const requestInputSchema = z
  .strictObject({
    url: urlFor([
      "http:",
      "https:",
    ]),
    method: z
      .enum([
        "GET",
        "HEAD",
        "POST",
        "PUT",
        "PATCH",
        "DELETE",
        "OPTIONS",
      ])
      .default("GET"),
    headers: requestHeaders.default([]),
    bodyBase64: base64.exactOptional(),
    maxResponseBytes: z
      .number()
      .int()
      .min(0)
      .max(MAX_BODY_BYTES)
      .default(MAX_BODY_BYTES),
    timeoutMs,
  })
  .refine(
    (input) =>
      input.bodyBase64 === undefined ||
      ![
        "GET",
        "HEAD",
      ].includes(input.method),
    "GET and HEAD cannot have a body.",
  );
export const responseSchema = z.strictObject({
  status: z.number().int().min(100).max(599),
  headers,
  bodyBase64: base64,
});
export const exchangeInputSchema = z.strictObject({
  url: urlFor([
    "ws:",
    "wss:",
  ]),
  messages: z
    .array(z.string().max(MAX_BODY_BYTES))
    .max(64)
    .refine(
      (values) =>
        values.reduce(
          (bytes, value) => bytes + new TextEncoder().encode(value).length,
          0,
        ) <= MAX_BODY_BYTES,
      "Messages exceed the byte limit.",
    ),
  receiveCount: z.number().int().min(1).max(64),
  timeoutMs,
});
export const exchangeResultSchema = z.strictObject({
  messages: z
    .array(
      z.discriminatedUnion("kind", [
        z.strictObject({
          kind: z.literal("text"),
          text: z.string().max(MAX_BODY_BYTES),
        }),
        z.strictObject({
          kind: z.literal("binary"),
          base64,
        }),
      ]),
    )
    .max(64),
  close: z.strictObject({
    code: z.number().int().min(0).max(4999),
    reason: z.string().max(123),
    wasClean: z.boolean(),
  }),
});
/** HTTP request and response types inferred from the validated transport contract. */
export type NetworkRequest = z.input<typeof requestInputSchema>;
export type NetworkResponse = z.output<typeof responseSchema>;
