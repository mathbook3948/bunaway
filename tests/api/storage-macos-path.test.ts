import { expect, test } from "bun:test";
import { normalizeMacosPath } from "../../plugins/storage/src/platforms/macos-path.ts";

test("macOS storage paths keep absolute spellings unchanged, including system aliases", () => {
  for (const path of [
    "/Users/me/한글 값.txt",
    "/tmp/a.txt",
    "/var/folders/x/a b/c",
    "/a/b.",
    "/a/ b ",
    `/${"x".repeat(255)}`,
  ]) {
    expect(normalizeMacosPath(path)).toBe(path);
  }
});

test("macOS storage paths refuse relative, dotted, empty and unencodable parts", () => {
  for (const path of [
    "",
    "/",
    "relative/a.txt",
    "./a.txt",
    "C:/a.txt",
    "/a/../b",
    "/a/./b",
    "/a//b",
    "/a/b/",
    "/a/b\0c",
    "/a/b\nc",
    "/a/b\rc",
    "/a/\ud800",
    `/a/${"x".repeat(256)}`,
    `/${"a/".repeat(600)}x`,
  ]) {
    expect(() => normalizeMacosPath(path), path).toThrow(
      expect.objectContaining({
        code: "INVALID_ARGUMENT",
      }),
    );
  }
});
