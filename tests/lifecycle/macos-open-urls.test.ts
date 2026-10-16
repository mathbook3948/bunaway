import { expect, test } from "bun:test";
import {
  MAX_OPEN_URLS,
  MAX_OPEN_URLS_BYTES,
} from "@bunaway/runtime-bun/worker-channel";
import { normalizeOpenUrls } from "#native/macos/bun/open-urls";

test("non-file URLs are normalized and keep their arrival order", () => {
  expect(
    normalizeOpenUrls([
      "BunAway-Test://open/path?q=1",
      "https://Example.com",
      "bunaway-test://second",
    ]),
  ).toEqual({
    urls: [
      "bunaway-test://open/path?q=1",
      "https://example.com/",
      "bunaway-test://second",
    ],
    rejected: [],
  });
});

test("file URLs become the canonical form of the path they name", () => {
  const result = normalizeOpenUrls([
    "file:///tmp/a%20b/../c.txt",
    "file://localhost/tmp/d.txt",
    "file:///tmp/%E2%9C%93.txt",
  ]);
  expect(result.urls).toEqual([
    "file:///tmp/c.txt",
    "file:///tmp/d.txt",
    "file:///tmp/%E2%9C%93.txt",
  ]);
  expect(result.rejected).toEqual([]);
});

test("ambiguous or invalid entries are rejected alone and reported without their URL", () => {
  const result = normalizeOpenUrls([
    "bunaway-test://kept",
    "not a url",
    "file://remote.example/share/a.txt",
    "file:///tmp/a%2Fb",
    "file:///tmp/a%2fb",
    "file:///tmp/a%00b",
    "bunaway-test://also-kept",
  ]);
  expect(result.urls).toEqual([
    "bunaway-test://kept",
    "bunaway-test://also-kept",
  ]);
  expect(result.rejected).toEqual([
    {
      index: 1,
      reason: "invalid-url",
    },
    {
      index: 2,
      reason: "file-host",
    },
    {
      index: 3,
      reason: "encoded-separator",
    },
    {
      index: 4,
      reason: "encoded-separator",
    },
    {
      index: 5,
      reason: "encoded-nul",
    },
  ]);
  expect(JSON.stringify(result.rejected)).not.toContain("example");
});

test("a request over the entry or size limit is rejected as a whole", () => {
  const limit = Array.from(
    {
      length: MAX_OPEN_URLS,
    },
    () => "a:",
  );
  expect(normalizeOpenUrls(limit).urls).toHaveLength(MAX_OPEN_URLS);
  expect(
    normalizeOpenUrls([
      ...limit,
      "a:",
    ]),
  ).toEqual({
    rejectedAll: "too-many-urls",
    urls: [],
    rejected: [],
  });
  const prefix = "a:";
  const exact = prefix + "x".repeat(MAX_OPEN_URLS_BYTES - prefix.length);
  expect(
    normalizeOpenUrls([
      exact,
    ]).urls,
  ).toHaveLength(1);
  expect(
    normalizeOpenUrls([
      exact,
      "a:",
    ]),
  ).toEqual({
    rejectedAll: "too-large",
    urls: [],
    rejected: [],
  });
  // Bytes, not characters, are counted: each of these is three bytes in UTF-8.
  expect(
    normalizeOpenUrls([
      `a:${"€".repeat(MAX_OPEN_URLS_BYTES / 3)}`,
    ]).rejectedAll,
  ).toBe("too-large");
});
