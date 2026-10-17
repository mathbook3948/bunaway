import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
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
    '<toast duration="long"><visual><binding template="ToastGeneric"><image placement="appLogoOverride" src="file:///C:/Users/a%20b/icon%261.png"/><image placement="hero" src="file:///D:/pics/%ED%95%9C%EA%B8%80&apos;.jpg"/><text>t</text><text></text></binding></visual><audio src="ms-winsoundevent:Notification.Looping.Call3" loop="true"/></toast>',
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
  expect(xml({})).toStartWith("<toast><visual>");
  expect(
    xml({
      sound: "Mail",
    }),
  ).toStartWith("<toast><visual>");
  expect(
    xml({
      sound: "Looping.Alarm",
      soundLoop: true,
    }),
  ).toStartWith('<toast duration="long"><visual>');
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
    `C:\\${"a".repeat(260)}.png`,
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
const DIRECTORY = 0x10;
const REPARSE_POINT = 0x400;
const INVALID = 0xffffffff;

/**
 * Stub probes over a real temp directory. Tests run on any OS, so the Windows-style path built by the
 * check (`tmp\dir\file`) is mapped back to a POSIX path. Overrides win over the real file system.
 */
function stubFilesystem(
  overrides: Record<string, number> = {},
  driveType = 3,
  probed: string[] = [],
) {
  return {
    driveType: () => driveType,
    attributes(path: string) {
      probed.push(path);
      const posix = `/${path.replaceAll("\\", "/")}`;
      if (posix in overrides) {
        return overrides[posix] ?? NORMAL;
      }
      try {
        return statSync(posix).isDirectory() ? DIRECTORY : NORMAL;
      } catch {
        return INVALID;
      }
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
        stubFilesystem(),
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

test("links, reparse points and cloud placeholders are refused without following them", () => {
  const directory = mkdtempSync(join(tmpdir(), "bunaway-media-"));
  try {
    mkdirSync(join(directory, "dir"));
    const file = join(directory, "dir", "a.png");
    writeFileSync(file, "x");
    const run = (overrides: Record<string, number>, probed: string[] = []) =>
      assertToastMediaFiles(
        {
          ...base,
          image: file,
        },
        stubFilesystem(overrides, 3, probed),
      );
    expect(() => run({})).not.toThrow();
    // A reparse point on an intermediate directory stops the walk before deeper components are probed.
    const probed: string[] = [];
    expect(() =>
      run(
        {
          [join(directory, "dir")]: REPARSE_POINT | DIRECTORY,
        },
        probed,
      ),
    ).toThrow(
      "Notification image path must not contain links or reparse points.",
    );
    expect(probed.at(-1)?.replaceAll("\\", "/")).toBe(
      join(directory, "dir").slice(1),
    );
    // The final file itself may be a link.
    expect(() =>
      run({
        [file]: REPARSE_POINT,
      }),
    ).toThrow("links or reparse points");
    for (const attribute of [
      0x1000,
      0x40000,
      0x400000,
    ]) {
      expect(() =>
        run({
          [file]: NORMAL | attribute,
        }),
      ).toThrow("Notification image must be stored locally.");
    }
    expect(() =>
      run({
        [file]: INVALID,
      }),
    ).toThrow("Notification image is not a readable regular file.");
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
