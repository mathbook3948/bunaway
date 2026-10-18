import { expect, test } from "bun:test";
import { relative, resolve } from "node:path";
import {
  isWindowsExecutableName,
  isWindowsFileName,
  sanitizeWindowsFileName,
} from "@bunaway/protocol";

const repository = resolve(import.meta.dir, "../..");
const SHARED_MODULE = "packages/protocol/src/windows-file-name.ts";
/**
 * The two rules a local copy has to repeat: the reserved device-name alternation and the
 * forbidden-character class together with the control characters. A looser filter, such as a
 * dialog's suggested file name, does not reproduce both and is not a second copy of the rules.
 */
const LOCAL_RULES = [
  /\b(?:con|prn|aux|nul)\|/i,
  /<>:"\/\\\\\|\?\*\\x00/,
];
const ROOTS = [
  "packages",
  "plugins",
  "native",
];

test("Windows file-name rules live in one module", async () => {
  const offenders: string[] = [];
  for (const root of ROOTS) {
    for await (const file of new Bun.Glob("**/src/**/*.ts").scan({
      cwd: resolve(repository, root),
      absolute: true,
    })) {
      const path = relative(repository, file);
      if (path === SHARED_MODULE || path.includes("node_modules")) {
        continue;
      }
      const text = await Bun.file(file).text();
      if (LOCAL_RULES.some((rule) => rule.test(text))) {
        offenders.push(path);
      }
    }
  }
  expect(offenders).toEqual([]);
});

test("file names reject reserved devices, forbidden characters and trailing dots or spaces", () => {
  for (const name of [
    "a.txt",
    "한글 이름.txt",
    "com10.txt",
    "console",
    "a.b",
  ]) {
    expect(isWindowsFileName(name)).toBe(true);
  }
  for (const name of [
    "",
    ".",
    "..",
    "CON",
    "con.txt",
    "Nul.tar.gz",
    "COM1",
    "lpt¹.log",
    "a:b",
    "a/b",
    "a\\b",
    "a\0b",
    "a*",
    "name.",
    "name ",
    "a".repeat(256),
  ]) {
    expect(isWindowsFileName(name)).toBe(false);
  }
  expect(isWindowsFileName("a".repeat(255))).toBe(true);
  expect(isWindowsFileName("abcd", 3)).toBe(false);
});

test("executable names apply the file-name rules to the stem", () => {
  for (const name of [
    "app.exe",
    "APP.EXE",
    "my app.exe",
    "a.b.exe",
  ]) {
    expect(isWindowsExecutableName(name)).toBe(true);
  }
  for (const name of [
    ".exe",
    "CON.exe",
    "nul.app.exe",
    "COM¹.exe",
    "app. .exe",
    "app..exe",
    "app.cmd",
    "../app.exe",
    "app\0.exe",
    "app",
  ]) {
    expect(isWindowsExecutableName(name)).toBe(false);
  }
  expect(isWindowsExecutableName(`${"a".repeat(120)}.exe`, 120)).toBe(true);
  expect(isWindowsExecutableName(`${"a".repeat(121)}.exe`, 120)).toBe(false);
});

test("sanitizing replaces forbidden characters and trims the end", () => {
  expect(sanitizeWindowsFileName('My: App/"v2"?. ')).toBe("My_ App__v2__");
  expect(sanitizeWindowsFileName("...")).toBe("");
});
