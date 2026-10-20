import { expect, test } from "bun:test";
import {
  fromFileSystemPath,
  normalizeWindowsPath,
  toFileSystemPath,
} from "../../plugins/storage/src/platforms/windows-path.ts";

test("Windows storage paths keep valid drive and UNC spellings, with forward slashes as backslashes", () => {
  expect(normalizeWindowsPath("C:\\Users\\me\\한글 값.txt")).toBe(
    "C:\\Users\\me\\한글 값.txt",
  );
  expect(normalizeWindowsPath("c:/data/a/b.txt")).toBe("c:\\data\\a\\b.txt");
  expect(normalizeWindowsPath("\\\\localhost\\C$\\dir\\a.txt")).toBe(
    "\\\\localhost\\C$\\dir\\a.txt",
  );
  expect(normalizeWindowsPath("//server/share/a.txt")).toBe(
    "\\\\server\\share\\a.txt",
  );
});

test("Windows storage paths refuse relative, dotted, empty and unnamable parts", () => {
  for (const path of [
    "relative\\a.txt",
    "C:a.txt",
    "\\rooted\\a.txt",
    "C:\\",
    "C:\\a\\..\\b",
    "C:\\a\\.\\b",
    "C:\\a\\\\b",
    "C:\\a\\b\\",
    "C:\\a\\b.",
    "C:\\a\\b ",
    "C:\\a\\CON",
    "C:\\a\\nul.txt",
    "C:\\a\\com1",
    "C:\\a\\b:stream",
    "C:\\a\\b<c",
    "C:\\a\\b?c",
    "C:\\a\\b*c",
    "C:\\a\\b\u0001c",
    `C:\\a\\${"x".repeat(256)}`,
    "\\\\server\\share",
    "\\\\server\\",
  ]) {
    expect(() => normalizeWindowsPath(path), path).toThrow(
      expect.objectContaining({
        code: "INVALID_ARGUMENT",
      }),
    );
  }
});

test("device namespace and NT object prefixes are refused", () => {
  for (const path of [
    "\\\\?\\C:\\a.txt",
    "\\\\?\\UNC\\server\\share\\a.txt",
    "\\\\.\\PhysicalDrive0",
    "\\\\.\\C:\\a.txt",
    "\\??\\C:\\a.txt",
    "\\??\\UNC\\server\\share\\a.txt",
    "\\\\??\\C:\\a.txt",
    "//?/C:/a.txt",
    "//./C:/a.txt",
  ]) {
    expect(() => normalizeWindowsPath(path), path).toThrow(
      expect.objectContaining({
        code: "INVALID_ARGUMENT",
      }),
    );
  }
});

test("short paths keep their spelling for file system calls", () => {
  expect(toFileSystemPath("C:\\data\\a.txt")).toBe("C:\\data\\a.txt");
  const nearLimit = `C:\\${"a".repeat(240)}`;
  expect(toFileSystemPath(nearLimit)).toBe(nearLimit);
});

test("long drive and UNC paths get the extended-length prefix and lose it again", () => {
  const drive = `C:\\${"a".repeat(100)}\\${"b".repeat(100)}\\${"c".repeat(100)}.txt`;
  expect(toFileSystemPath(drive)).toBe(`\\\\?\\${drive}`);
  expect(fromFileSystemPath(toFileSystemPath(drive))).toBe(drive);
  const unc = `\\\\server\\share\\${"a".repeat(120)}\\${"b".repeat(120)}.txt`;
  expect(toFileSystemPath(unc)).toBe(`\\\\?\\UNC\\${unc.slice(2)}`);
  expect(fromFileSystemPath(toFileSystemPath(unc))).toBe(unc);
});

test("a long path is accepted in the app's own drive spelling and refused with the prefix", () => {
  const accepted = normalizeWindowsPath(
    `C:/${"a".repeat(120)}/${"b".repeat(120)}/c.txt`,
  );
  expect(toFileSystemPath(accepted).startsWith("\\\\?\\C:\\")).toBe(true);
  expect(() =>
    normalizeWindowsPath(`\\\\?\\C:\\${"a".repeat(120)}\\${"b".repeat(120)}`),
  ).toThrow(
    expect.objectContaining({
      code: "INVALID_ARGUMENT",
    }),
  );
});
