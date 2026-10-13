import { expect, test } from "bun:test";
import { network, networkPlugin } from "@bunaway/plugin-network";
import { NativeRegistry } from "@bunaway/protocol";
import {
  MAX_BODY_BYTES,
  networkOperations,
} from "#plugins/network/src/contract";

test("network schemas reject credential URLs, unsafe headers, unsupported options and malformed or oversized bodies", () => {
  const request = networkOperations.request.input;
  for (const url of [
    "file:///tmp/data",
    "http://user:pass@example.com",
    "http://example.com/#fragment",
    "http://example.com/\n",
    "http://example.com/\\path",
    "relative",
    "ws://example.com",
  ]) {
    expect(
      request.safeParse({
        url,
      }).success,
    ).toBe(false);
  }
  for (const headers of [
    [
      [
        "Origin",
        "https://example.com",
      ],
    ],
    [
      [
        "Host",
        "example.com",
      ],
    ],
    [
      [
        "cookie",
        "secret",
      ],
    ],
    [
      [
        "Content-Length",
        "4",
      ],
    ],
    [
      [
        "x-test",
        "injected\r\nvalue",
      ],
    ],
    [
      [
        "x-test",
        "trailing\n",
      ],
    ],
    [
      [
        "Sec-WebSocket-Key",
        "key",
      ],
    ],
  ]) {
    expect(
      request.safeParse({
        url: "https://example.com",
        headers,
      }).success,
    ).toBe(false);
  }
  for (const bodyBase64 of [
    "a",
    "!!!!",
    "YQ==\n",
    Buffer.alloc(MAX_BODY_BYTES + 1).toString("base64"),
  ]) {
    expect(
      request.safeParse({
        url: "https://example.com",
        method: "POST",
        bodyBase64,
      }).success,
    ).toBe(false);
  }
  expect(
    request.safeParse({
      url: "https://example.com",
      method: "POST",
      bodyBase64: Buffer.alloc(MAX_BODY_BYTES).toString("base64"),
    }).success,
  ).toBe(true);
  expect(
    request.safeParse({
      url: "https://example.com",
      method: "GET",
      bodyBase64: "",
    }).success,
  ).toBe(false);
  expect(
    request.safeParse({
      url: "https://example.com",
      proxy: "http://proxy",
    }).success,
  ).toBe(false);
  expect(
    request.safeParse({
      url: "https://example.com",
      headers: Array.from(
        {
          length: 5,
        },
        () => [
          "x",
          "x".repeat(4096),
        ],
      ),
    }).success,
  ).toBe(false);
  expect(
    networkOperations.exchange.input.safeParse({
      url: "ws://example.com",
      messages: [
        "😀".repeat(16385),
      ],
      receiveCount: 1,
    }).success,
  ).toBe(false);
});

test("network operations require independent grants and expose no persistent socket handle", () => {
  const registry = new NativeRegistry([
    networkPlugin,
  ]);
  expect(Object.keys(network)).toEqual([
    "request",
    "exchange",
  ]);
  for (const name of [
    "request",
    "exchange",
  ]) {
    const call = {
      operation: `network.${name}`,
      payload: null,
    };
    expect(
      registry.allowed(
        {
          permissions: [
            call.operation,
          ],
        },
        call,
      ),
    ).toBe(true);
    expect(
      registry.allowed(
        {
          permissions: [],
        },
        call,
      ),
    ).toBe(false);
    expect(
      registry.allowed(
        {
          permissions: [
            `network.${name === "request" ? "exchange" : "request"}`,
          ],
        },
        call,
      ),
    ).toBe(false);
  }
});
