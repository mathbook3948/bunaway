import { base64Schema } from "@bunaway/plugin";
import { z } from "zod";
/** Transport limits leave space for protocol envelopes and base64 expansion. */
export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_HEADER_BYTES = 16 * 1024;
export const MAX_NETWORK_TIMEOUT_MS = 30_000;
const base64 = base64Schema(MAX_BODY_BYTES, "Body exceeds the byte limit.");
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
/** Longest DNS name and label in octets, RFC 1035. */
export const MAX_HOST_LENGTH = 253;
const MAX_HOST_LABEL_LENGTH = 63;
/** Upper bound on addresses returned for one name. Extra addresses are dropped in resolver order. */
export const MAX_RESOLVED_ENDPOINTS = 64;
const hostLabel = new RegExp(
  `^[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,${MAX_HOST_LABEL_LENGTH - 2}}[A-Za-z0-9_])?$`,
);
const IPV4_OCTET = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
/** Four decimal octets without leading zeros, so no resolver reads them as octal. */
const dottedQuad = new RegExp(`^(?:${IPV4_OCTET}\\.){3}${IPV4_OCTET}$`);
/** A last label of digits or 0x digits makes getaddrinfo read the whole name as an IPv4 number. */
const numericLastLabel = /^(?:\d+|0[xX][0-9A-Fa-f]*)$/;
/** `network.resolveHost` input: an ASCII host name or IPv4 literal, with no scheme, port or path. */
export const resolveHostInputSchema = z.strictObject({
  host: z
    .string()
    .min(1)
    .max(MAX_HOST_LENGTH + 1)
    .refine((value) => {
      const name = value.endsWith(".") ? value.slice(0, -1) : value;
      const labels = name.split(".");
      if (
        name.length === 0 ||
        name.length > MAX_HOST_LENGTH ||
        !labels.every((label) => hostLabel.test(label))
      ) {
        return false;
      }
      // Shorthand such as "1", "0x7f.1" or "2130706433" is an address, not a name; accept only a strict IPv4 literal.
      return (
        !numericLastLabel.test(labels.at(-1) ?? "") || dottedQuad.test(name)
      );
    }, "Expected an ASCII host name or dotted IPv4 address; convert international names to punycode."),
  /**
   * "A" resolves IPv4 addresses and "AAAA" IPv6 addresses, asking the resolver for that family; a
   * name without such addresses fails like an unknown name, and an IPv4 literal asked for "AAAA"
   * gives an empty list. Omitted returns both families.
   */
  queryType: z
    .enum([
      "A",
      "AAAA",
    ])
    .optional(),
  timeoutMs,
});
/** Addresses in resolver order, shaped like Electron `net.resolveHost()`. */
export const resolveHostResultSchema = z.strictObject({
  endpoints: z
    .array(
      z.strictObject({
        address: z.string().min(1).max(64),
        family: z.enum([
          "ipv4",
          "ipv6",
        ]),
      }),
    )
    .max(MAX_RESOLVED_ENDPOINTS),
});
/** Upper bound on proxies returned for one URL. Extra entries are dropped in configured order. */
export const MAX_PROXY_ENTRIES = 16;
/** `network.resolveProxy` input: the http or https URL whose system proxy route is asked for. */
export const resolveProxyInputSchema = z.strictObject({
  url: urlFor([
    "http:",
    "https:",
  ]),
  timeoutMs,
});
/**
 * Where the system sends a request for the URL, in the order to try. This is the structured form
 * of the PAC string Electron `session.resolveProxy()` returns (`"PROXY host:80; DIRECT"`), so an
 * app does not parse a string. Proxy credentials are never returned.
 */
export const resolveProxyResultSchema = z.strictObject({
  entries: z
    .array(
      z.discriminatedUnion("kind", [
        z.strictObject({
          kind: z.literal("direct"),
        }),
        z.strictObject({
          kind: z.literal("proxy"),
          scheme: z.enum([
            "http",
            "https",
            "socks4",
            "socks5",
          ]),
          host: z.string().min(1).max(MAX_HOST_LENGTH),
          port: z.number().int().min(1).max(65535),
        }),
      ]),
    )
    .min(1)
    .max(MAX_PROXY_ENTRIES),
});
/** Largest body one download writes. */
export const MAX_DOWNLOAD_BYTES = 4 * 1024 * 1024 * 1024;
/** Whole-download deadline: the default, and the longest a caller may ask for. */
export const DEFAULT_DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
export const MAX_DOWNLOAD_TIMEOUT_MS = 60 * 60_000;
/** Longest gap without a body chunk before a download fails with a timeout. */
export const DEFAULT_DOWNLOAD_IDLE_TIMEOUT_MS = 30_000;
export const MAX_DOWNLOAD_IDLE_TIMEOUT_MS = 5 * 60_000;
/** Downloads in flight at once, counted apart from the 16 bounded requests. */
export const MAX_ACTIVE_DOWNLOADS = 4;
export const MAX_DOWNLOAD_PATH_LENGTH = 4096;
const downloadId = z.uuid();
/**
 * `network.download` input. The app checks `path` against its own rules before the call; the plugin
 * only requires an absolute path whose parent folder exists. `downloadId` is chosen by the caller
 * so `network.downloadStatus` and `network.cancelDownload` can name the transfer while it runs.
 */
export const downloadInputSchema = z.strictObject({
  downloadId,
  url: urlFor([
    "http:",
    "https:",
  ]),
  path: z.string().min(1).max(MAX_DOWNLOAD_PATH_LENGTH),
  headers: requestHeaders.default([]),
  maxBytes: z.number().int().min(1).max(MAX_DOWNLOAD_BYTES),
  timeoutMs: z
    .number()
    .int()
    .min(1)
    .max(MAX_DOWNLOAD_TIMEOUT_MS)
    .default(DEFAULT_DOWNLOAD_TIMEOUT_MS),
  idleTimeoutMs: z
    .number()
    .int()
    .min(1)
    .max(MAX_DOWNLOAD_IDLE_TIMEOUT_MS)
    .default(DEFAULT_DOWNLOAD_IDLE_TIMEOUT_MS),
  overwrite: z.boolean().default(false),
});
/**
 * A 2xx body is written to `path` and `saved` is true. Any other status, redirects included, is
 * returned like `network.request` does and creates no file.
 */
export const downloadResultSchema = z.strictObject({
  status: z.number().int().min(100).max(599),
  headers,
  saved: z.boolean(),
  bytesWritten: z.number().int().min(0).max(MAX_DOWNLOAD_BYTES),
});
export const downloadIdInputSchema = z.strictObject({
  downloadId,
});
/** Progress of a running download; `totalBytes` is null when the response has no length. */
export const downloadStatusSchema = z.strictObject({
  receivedBytes: z.number().int().min(0).max(MAX_DOWNLOAD_BYTES),
  totalBytes: z.number().int().min(0).max(MAX_DOWNLOAD_BYTES).nullable(),
});
export const emptyResultSchema = z.strictObject({});
/** `network.isOnline` result: whether a non-loopback network connection exists. */
export const onlineSchema = z.boolean();
/** Native events use the protocol's portable schema representation. */
export const networkEvents = {
  "network.onlineChanged": {
    type: "object",
    properties: {
      online: {
        type: "boolean",
      },
    },
    required: [
      "online",
    ],
    additionalProperties: false,
  },
} as const;
/** HTTP request and response types inferred from the validated transport contract. */
export type NetworkRequest = z.input<typeof requestInputSchema>;
export type NetworkResponse = z.output<typeof responseSchema>;
