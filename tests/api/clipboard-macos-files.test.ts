import { expect, test } from "bun:test";
import {
  MAX_FILES,
  MAX_PATH_LENGTH,
  macosWriteFormatsSchema,
  writeFormatsSchema,
} from "#plugins/clipboard/src/contract";
import {
  filePath,
  fileUrl,
} from "#plugins/clipboard/src/platforms/macos-pasteboard";

const fileList = (data: string[]) => ({
  items: [
    {
      format: "application/x-bunaway-file-list" as const,
      data,
    },
  ],
});

test("the macOS file-list contract accepts absolute POSIX paths only", () => {
  const accepted = [
    "/",
    "/Users/me/한글 😀 #1.txt",
    "/tmp/../tmp/100%.txt",
    `/${"a".repeat(MAX_PATH_LENGTH - 1)}`,
  ];
  expect(macosWriteFormatsSchema.parse(fileList(accepted))).toEqual(
    fileList(accepted),
  );
  const rejected: string[][] = [
    [
      "relative/path",
    ],
    [
      "C:\\memo.txt",
    ],
    [
      "file:///tmp/a",
    ],
    [
      "/tmp/a\nb",
    ],
    [
      "/tmp/a\0b",
    ],
    [
      "/tmp/\u007f",
    ],
    [
      `/${"a".repeat(MAX_PATH_LENGTH)}`,
    ],
    [],
    Array.from(
      {
        length: MAX_FILES + 1,
      },
      (_, index) => `/f${index}`,
    ),
  ];
  for (const data of rejected) {
    expect(macosWriteFormatsSchema.safeParse(fileList(data)).success).toBe(
      false,
    );
  }
});

test("the Windows file-list contract still rejects POSIX paths", () => {
  expect(
    writeFormatsSchema.safeParse(
      fileList([
        "/tmp/a",
      ]),
    ).success,
  ).toBe(false);
  expect(
    writeFormatsSchema.safeParse(
      fileList([
        "C:\\memo.txt",
      ]),
    ).success,
  ).toBe(true);
});

test("file URLs round-trip paths without normalizing them", () => {
  for (const path of [
    "/",
    "/Users/me/My Dir/한글 😀 #1?.txt",
    "/tmp/../tmp/100%.txt",
    "/a//b",
  ]) {
    const url = fileUrl(path);
    expect(url).toMatch(/^file:\/\/\//u);
    expect(url).not.toMatch(/[\s#?]/u);
    expect(filePath(url)).toBe(path);
  }
  expect(fileUrl("/a b/c")).toBe("file:///a%20b/c");
});

test("only local file URLs name a path", () => {
  expect(filePath("file:///Users/me/dir/")).toBe("/Users/me/dir");
  expect(filePath("FILE://LocalHost/Users/me")).toBe("/Users/me");
  expect(filePath("file:///")).toBe("/");
  // Remote hosts, file reference URLs and other schemes are not local paths.
  expect(filePath("file://server/share/file")).toBeNull();
  expect(filePath("file:///.file/id=6571367.9114570")).toBeNull();
  expect(filePath("https://example.com/a")).toBeNull();
  // Malformed file URLs are invalid pasteboard data, never a guessed path.
  for (const url of [
    "file:///bad%ZZ",
    "file:///a?b",
    "file:///a#b",
    "file:relative",
  ]) {
    expect(() => filePath(url)).toThrow(
      expect.objectContaining({
        code: "INTERNAL",
      }),
    );
  }
});
