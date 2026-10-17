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

test("MAX_TOAST_IMAGE_BYTES follows the documented 3 MB limit", () => {
  expect(MAX_TOAST_IMAGE_BYTES).toBe(3_000_000);
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

test("media files must exist, be regular files and stay within the size limit", () => {
  const directory = mkdtempSync(join(tmpdir(), "bunaway-media-"));
  try {
    const small = join(directory, "small.png");
    const large = join(directory, "large.png");
    writeFileSync(small, "x");
    writeFileSync(large, Buffer.alloc(MAX_TOAST_IMAGE_BYTES + 1));
    const resolve = (extra: Record<string, unknown>) =>
      notificationShowSchema.parse({
        id: "media",
        title: "t",
        ...extra,
      });
    // Schema validation accepts Windows paths only, so exercise the file check with a parsed value and patched paths.
    const withPaths = (icon: string | null, image: string | null) => ({
      ...resolve({}),
      icon,
      image,
    });
    const check = (
      icon: string | null,
      image: string | null,
      driveType: (path: string) => number = () => 3,
    ) => assertToastMediaFiles(withPaths(icon, image), driveType);
    const limit = join(directory, "limit.png");
    writeFileSync(limit, Buffer.alloc(MAX_TOAST_IMAGE_BYTES));
    expect(() => check(small, small)).not.toThrow();
    expect(() => check(limit, null)).not.toThrow();
    expect(() => check(null, null)).not.toThrow();
    const rejection = (path: string, slot: "icon" | "image") => {
      try {
        if (slot === "icon") {
          check(path, null);
        } else {
          check(null, path);
        }
      } catch (error) {
        expect(error).toMatchObject({
          code: "INVALID_ARGUMENT",
        });
        return (error as Error).message;
      }
      throw new Error("expected rejection");
    };
    for (const slot of [
      "icon",
      "image",
    ] as const) {
      expect(rejection(join(directory, "missing.png"), slot)).toBe(
        "Notification image is not a readable regular file.",
      );
      expect(rejection(directory, slot)).toBe(
        "Notification image is not a readable regular file.",
      );
      expect(rejection(large, slot)).toBe(
        "Notification image file is too large.",
      );
    }
    // Unknown, root-less and remote drives are refused; local types pass.
    for (const type of [
      0,
      1,
      4,
    ]) {
      expect(() => check(small, null, () => type)).toThrow(
        "Notification image must be on a local drive.",
      );
      expect(() => check(null, small, () => type)).toThrow(
        "Notification image must be on a local drive.",
      );
    }
    for (const type of [
      2,
      3,
      5,
      6,
    ]) {
      expect(() => check(small, null, () => type)).not.toThrow();
    }
    // The drive check precedes file I/O, so a remote path is refused as remote even when it cannot be stat-ed.
    expect(() => check(join(directory, "missing.png"), null, () => 4)).toThrow(
      "local drive",
    );
  } finally {
    rmSync(directory, {
      recursive: true,
      force: true,
    });
  }
});
