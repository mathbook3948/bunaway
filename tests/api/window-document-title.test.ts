import { expect, test } from "bun:test";
import { windowEvents } from "@bunaway/plugin-windows";
import { validateValue } from "@bunaway/protocol";
import {
  limitDocumentTitle,
  MAX_DOCUMENT_TITLE_LENGTH,
} from "#native/windows/bun/document-title";

const identity = {
  windowId: "window-1",
  viewId: "main",
};

test("a title within the limit is delivered unchanged", () => {
  expect(limitDocumentTitle("")).toBe("");
  expect(limitDocumentTitle("Inbox (3)")).toBe("Inbox (3)");
  const exact = "x".repeat(MAX_DOCUMENT_TITLE_LENGTH);
  expect(limitDocumentTitle(exact)).toBe(exact);
});

test("a longer title is cut to the code unit limit", () => {
  const cut = limitDocumentTitle("x".repeat(MAX_DOCUMENT_TITLE_LENGTH + 500));
  expect(cut.length).toBe(MAX_DOCUMENT_TITLE_LENGTH);
});

test("a surrogate pair straddling the limit is dropped whole", () => {
  const head = "x".repeat(MAX_DOCUMENT_TITLE_LENGTH - 1);
  expect(limitDocumentTitle(`${head}😀tail`)).toBe(head);
  // A pair that ends exactly at the limit survives.
  const fits = "x".repeat(MAX_DOCUMENT_TITLE_LENGTH - 2);
  expect(limitDocumentTitle(`${fits}😀tail`)).toBe(`${fits}😀`);
});

test("every limited title satisfies the event schema", () => {
  const title = limitDocumentTitle(`${"가".repeat(2000)}😀`);
  expect(
    validateValue(windowEvents["windows.documentTitleChanged"], {
      ...identity,
      title,
    }),
  ).toEqual({
    ...identity,
    title,
  });
});

test("the event schema rejects a missing or oversized title and extra fields", () => {
  const schema = windowEvents["windows.documentTitleChanged"];
  expect(() => validateValue(schema, identity)).toThrow();
  expect(() =>
    validateValue(schema, {
      ...identity,
      title: "x".repeat(MAX_DOCUMENT_TITLE_LENGTH + 1),
    }),
  ).toThrow();
  expect(() =>
    validateValue(schema, {
      ...identity,
      title: "a",
      url: "https://app.bunaway.local/",
    }),
  ).toThrow();
});
