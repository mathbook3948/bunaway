import { expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  checkFiles,
  findTextStyleViolations,
  isStyledTextPath,
  storedCommitMessage,
  trackedTextPaths,
} from "../../scripts/check-text-style.ts";

const repository = resolve(import.meta.dir, "../..");
const EM_DASH = String.fromCharCode(0x2014);
const MIDDLE_DOT = String.fromCharCode(0x00b7);

test("the text style checker reports each forbidden character with its line", () => {
  expect(
    findTextStyleViolations(
      "doc.md",
      `fine\nan em dash ${EM_DASH} here\nmid ${MIDDLE_DOT} dot\n`,
    ),
  ).toEqual([
    {
      path: "doc.md",
      line: 2,
      description: "em dash (U+2014)",
    },
    {
      path: "doc.md",
      line: 3,
      description: "middle dot (U+00B7)",
    },
  ]);
  expect(
    findTextStyleViolations("doc.md", "plain hyphen - and colon:"),
  ).toEqual([]);
});

test("the text style checker covers documentation and source text but not quoted licenses", () => {
  expect(isStyledTextPath("docs/GLOSSARY.md")).toBe(true);
  expect(isStyledTextPath("plugins/menu/src/contract.ts")).toBe(true);
  expect(isStyledTextPath("native/android/host/src/Main.java")).toBe(true);
  expect(isStyledTextPath("licenses/bun.txt")).toBe(false);
  expect(isStyledTextPath("THIRD-PARTY-NOTICES.txt")).toBe(false);
  expect(isStyledTextPath("bun.lock")).toBe(false);
  expect(isStyledTextPath("assets/icon.png")).toBe(false);
});

test("the commit message check ignores Git comments and the verbose diff below the scissors line", () => {
  const edited = [
    "fix: tidy wording",
    "",
    "# Please enter the commit message for your changes.",
    "# ------------------------ >8 ------------------------",
    "# Do not modify or remove the line above.",
    `+removed an em dash ${EM_DASH} from a comment`,
    "",
  ].join("\n");
  expect(storedCommitMessage(edited)).toBe("fix: tidy wording\n\n");
  expect(
    findTextStyleViolations("message", storedCommitMessage(edited)),
  ).toEqual([]);
  expect(
    storedCommitMessage(`subject\n; a comment\nbody ${MIDDLE_DOT}\n`, ";"),
  ).toBe(`subject\nbody ${MIDDLE_DOT}\n`);
  expect(
    findTextStyleViolations("message", `subject\n\nbody ${EM_DASH} here\n`),
  ).toHaveLength(1);
});

test("tracked documentation, source and commit-facing text contain no em dashes or middle dots", async () => {
  const paths = await trackedTextPaths(repository);
  expect(paths.length).toBeGreaterThan(100);
  const violations = checkFiles(paths.map((path) => resolve(repository, path)));
  expect(violations).toEqual([]);
});
