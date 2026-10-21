import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_TOAST_IMAGE_BYTES,
  notificationShowSchema,
} from "#plugins/notification/src/contract";
import {
  toastFileUri,
  toastXml,
} from "#plugins/notification/src/platforms/toast-controller";
import { assertToastMediaFiles } from "#plugins/notification/src/platforms/toast-media";

const parse = (extra: Record<string, unknown>) =>
  notificationShowSchema.safeParse({
    id: "media",
    title: "Hello",
    ...extra,
  });

test("toast XML places icon, inline or hero image and system sound with escaped file URIs", () => {
  const value = notificationShowSchema.parse({
    id: "media",
    title: "t",
    icon: "C:\\Users\\a b\\icon&1.png",
    image: "D:/pics/한글'.jpg",
    imagePlacement: "hero",
    sound: "Looping.Call3",
    soundLoop: true,
  });
  expect(toastXml(value)).toBe(
    '<toast launch="bunaway1;bunaway;media;" duration="long"><visual><binding template="ToastGeneric"><image placement="appLogoOverride" src="file:///C:/Users/a%20b/icon%261.png"/><image placement="hero" src="file:///D:/pics/%ED%95%9C%EA%B8%80&apos;.jpg"/><text>t</text><text></text></binding></visual><audio src="ms-winsoundevent:Notification.Looping.Call3" loop="true"/></toast>',
  );
  const inline = notificationShowSchema.parse({
    id: "media",
    title: "t",
    image: "C:\\x.png",
    sound: "Mail",
  });
  expect(toastXml(inline)).toContain('<image src="file:///C:/x.png"/>');
  expect(toastXml(inline)).toContain(
    '<audio src="ms-winsoundevent:Notification.Mail"/>',
  );
});

test("duration long is emitted only for looping sounds and paired surrogates stay valid", () => {
  const xml = (extra: Record<string, unknown>) =>
    toastXml(
      notificationShowSchema.parse({
        id: "media",
        title: "t",
        ...extra,
      }),
    );
  expect(xml({})).toStartWith(
    '<toast launch="bunaway1;bunaway;media;"><visual>',
  );
  expect(
    xml({
      sound: "Mail",
    }),
  ).toStartWith('<toast launch="bunaway1;bunaway;media;"><visual>');
  expect(
    xml({
      sound: "Looping.Alarm",
      soundLoop: true,
    }),
  ).toStartWith(
    '<toast launch="bunaway1;bunaway;media;" duration="long"><visual>',
  );
  expect(
    xml({
      sound: "Looping.Alarm",
      soundLoop: true,
    }),
  ).toContain('loop="true"');
  expect(
    parse({
      icon: "C:\\emoji-🚀.png",
    }).success,
  ).toBe(true);
});

test("file URI conversion encodes each path segment and keeps the drive", () => {
  expect(toastFileUri("c:\\a#b\\c%d\\e?.png")).toBe(
    "file:///c:/a%23b/c%25d/e%3F.png",
  );
});

test("media schema rejects unsafe paths, formats and conflicting sound options", () => {
  expect(
    parse({
      icon: "C:\\ok\\a.PNG",
      image: "C:/ok/a.gif",
    }).success,
  ).toBe(true);
  for (const bad of [
    "relative\\a.png",
    "\\\\server\\share\\a.png",
    "\\\\?\\C:\\a.png",
    "C:\\a\\..\\b.png",
    "C:\\a.svg",
    "C:\\a.png\u0000",
    "C:\\a<b>.png",
    "https://example.com/a.png",
    "file:///C:/a.png",
    `C:\\${"a".repeat(253)}.png`,
    "C:\\a.png:stream.png",
    "C:\\dir:ads\\a.png",
    "C:\\a\ud800.png",
    "C:\\a\udc00b.png",
  ]) {
    expect(
      parse({
        icon: bad,
      }).success,
      bad,
    ).toBe(false);
    expect(
      parse({
        image: bad,
      }).success,
      bad,
    ).toBe(false);
  }
  // 259 characters is the longest accepted path, because MAX_PATH counts the terminating NUL.
  expect(
    parse({
      icon: `C:\\${"a".repeat(252)}.png`,
    }).success,
  ).toBe(true);
  expect(
    parse({
      sound: "C:\\a.wav",
    }).success,
  ).toBe(false);
  expect(
    parse({
      silent: true,
      sound: "Mail",
    }).success,
  ).toBe(false);
  expect(
    parse({
      soundLoop: true,
    }).success,
  ).toBe(false);
  expect(
    parse({
      sound: "Mail",
      soundLoop: true,
    }).success,
  ).toBe(false);
  expect(
    parse({
      sound: "Looping.Alarm",
      soundLoop: true,
    }).success,
  ).toBe(true);
  expect(
    parse({
      silent: true,
    }).success,
  ).toBe(true);
  expect(
    parse({
      imagePlacement: "background",
    }).success,
  ).toBe(false);
});

// Windows attribute values used by the stub filesystem.
const NORMAL = 0x80;
const REPARSE_POINT = 0x400;
const INVALID = 0xffffffff;

/** Platform-neutral path key: separators, a leading root separator and case do not matter. */
const pathKey = (path: string) =>
  path
    .replace(/^[\\/]+/, "")
    .replaceAll("/", "\\")
    .toLowerCase();

/**
 * Virtual attribute tree: only listed paths have attributes and unlisted paths are INVALID. Keys are matched by pathKey, so the same test passes with POSIX temp paths
 * on Linux and `C:\` paths on Windows, without translating the probed path back to a real one.
 */
function stubFilesystem(
  entries: Record<string, number> = {},
  driveType = 3,
  probed: string[] = [],
) {
  const tree = new Map<string, number>();
  for (const [path, attributes] of Object.entries(entries)) {
    tree.set(pathKey(path), attributes);
  }
  return {
    driveType: () => driveType,
    attributes(path: string) {
      probed.push(path);
      return tree.get(pathKey(path)) ?? INVALID;
    },
  };
}

// Schema validation accepts Windows paths only, so the file check is exercised with patched paths.
const base = notificationShowSchema.parse({
  id: "media",
  title: "t",
});

test("media files must be local regular files within the size limit", () => {
  const directory = mkdtempSync(join(tmpdir(), "bunaway-media-"));
  try {
    const small = join(directory, "small.png");
    const large = join(directory, "large.png");
    const limit = join(directory, "limit.png");
    writeFileSync(small, "x");
    writeFileSync(large, Buffer.alloc(MAX_TOAST_IMAGE_BYTES + 1));
    writeFileSync(limit, Buffer.alloc(MAX_TOAST_IMAGE_BYTES));
    const check = (icon: string | null, image: string | null) =>
      assertToastMediaFiles(
        {
          ...base,
          icon,
          image,
        },
        stubFilesystem({
          [small]: NORMAL,
          [large]: NORMAL,
          [limit]: NORMAL,
        }),
      );
    expect(() => check(small, small)).not.toThrow();
    expect(() => check(limit, null)).not.toThrow();
    expect(() => check(null, null)).not.toThrow();
    const cases = [
      [
        join(directory, "missing.png"),
        "Notification image is not a readable regular file.",
      ],
      [
        directory,
        "Notification image is not a readable regular file.",
      ],
      [
        large,
        "Notification image file is too large.",
      ],
    ] as const;
    for (const [path, message] of cases) {
      for (const run of [
        () => check(path, null),
        () => check(null, path),
      ]) {
        expect(run).toThrow(message);
        expect(run).toThrow(
          expect.objectContaining({
            code: "INVALID_ARGUMENT",
          }),
        );
      }
    }
  } finally {
    rmSync(directory, {
      recursive: true,
      force: true,
    });
  }
});

test("only fixed and RAM drives are read, before any file access", () => {
  const probed: string[] = [];
  for (const type of [
    0,
    1,
    2,
    4,
    5,
  ]) {
    expect(() =>
      assertToastMediaFiles(
        {
          ...base,
          icon: "/nonexistent/a.png",
        },
        stubFilesystem({}, type, probed),
      ),
    ).toThrow("Notification image must be on a local fixed drive.");
  }
  expect(probed).toEqual([]);
  for (const type of [
    3,
    6,
  ]) {
    expect(() =>
      assertToastMediaFiles(
        {
          ...base,
          icon: "/nonexistent/a.png",
        },
        stubFilesystem({}, type),
      ),
    ).toThrow("not a readable regular file");
  }
});

test("a linked path is not rejected and cloud placeholders are refused", () => {
  const directory = mkdtempSync(join(tmpdir(), "bunaway-media-"));
  try {
    const file = join(directory, "a.png");
    writeFileSync(file, "x");
    const probed: string[] = [];
    const run = (attributes: number) =>
      assertToastMediaFiles(
        {
          ...base,
          image: file,
        },
        stubFilesystem(
          {
            [file]: attributes,
          },
          3,
          probed,
        ),
      );
    expect(() => run(NORMAL)).not.toThrow();
    // Only the file itself is probed, once; a link on it or on a parent folder is not rejected.
    expect(probed.map(pathKey)).toEqual([
      pathKey(file),
    ]);
    // GetFileAttributesW reports a final link's own attributes, so this stands for a link without a cloud flag.
    expect(() => run(NORMAL | REPARSE_POINT)).not.toThrow();
    for (const attribute of [
      0x1000,
      0x40000,
      0x400000,
    ]) {
      expect(() => run(NORMAL | attribute)).toThrow(
        "Notification image must be stored locally.",
      );
    }
    expect(() => run(INVALID)).toThrow(
      "Notification image is not a readable regular file.",
    );
  } finally {
    rmSync(directory, {
      recursive: true,
      force: true,
    });
  }
});

test("hero placement requires an image and bmp is not accepted", () => {
  expect(
    parse({
      imagePlacement: "hero",
    }).success,
  ).toBe(false);
  expect(
    parse({
      image: "C:\\a.png",
      imagePlacement: "hero",
    }).success,
  ).toBe(true);
  expect(
    parse({
      image: "C:\\a.bmp",
    }).success,
  ).toBe(false);
  expect(
    parse({
      icon: "C:\\a.bmp",
    }).success,
  ).toBe(false);
});
