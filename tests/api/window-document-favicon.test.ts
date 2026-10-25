import { expect, test } from "bun:test";
import { windowEvents } from "@bunaway/plugin-windows";
import { validateValue } from "@bunaway/protocol";
import {
  limitFaviconUrl,
  MAX_FAVICON_URL_LENGTH,
} from "#native/windows/bun/document-favicon";

const identity = {
  windowId: "window-1",
  viewId: "main",
};
const schema = windowEvents["windows.documentFaviconChanged"];

test("an address within the limit is delivered unchanged", () => {
  expect(limitFaviconUrl("")).toBe("");
  const url = "https://app.bunaway.local/icon.png";
  expect(limitFaviconUrl(url)).toBe(url);
  const exact = `https://a.test/${"x".repeat(MAX_FAVICON_URL_LENGTH - 15)}`;
  expect(exact.length).toBe(MAX_FAVICON_URL_LENGTH);
  expect(limitFaviconUrl(exact)).toBe(exact);
});

test("an address over the limit is reported as empty instead of cut", () => {
  expect(limitFaviconUrl(`data:image/png;base64,${"A".repeat(5000)}`)).toBe("");
  expect(limitFaviconUrl("x".repeat(MAX_FAVICON_URL_LENGTH + 1))).toBe("");
});

test("every limited address satisfies the event schema", () => {
  for (const raw of [
    "",
    "https://app.bunaway.local/icon.png",
    "x".repeat(MAX_FAVICON_URL_LENGTH * 2),
  ]) {
    const url = limitFaviconUrl(raw);
    expect(
      validateValue(schema, {
        ...identity,
        url,
      }),
    ).toEqual({
      ...identity,
      url,
    });
  }
});

test("the event schema rejects a missing or oversized address and extra fields", () => {
  expect(() => validateValue(schema, identity)).toThrow();
  expect(() =>
    validateValue(schema, {
      ...identity,
      url: "x".repeat(MAX_FAVICON_URL_LENGTH + 1),
    }),
  ).toThrow();
  expect(() =>
    validateValue(schema, {
      ...identity,
      url: "",
      title: "a",
    }),
  ).toThrow();
});
