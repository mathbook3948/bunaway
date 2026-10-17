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
    '<toast><visual><binding template="ToastGeneric"><image placement="appLogoOverride" src="file:///C:/Users/a%20b/icon%261.png"/><image placement="hero" src="file:///D:/pics/%ED%95%9C%EA%B8%80&apos;.jpg"/><text>t</text><text></text></binding></visual><audio src="ms-winsoundevent:Notification.Looping.Call3" loop="true"/></toast>',
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
    expect(() => assertToastMediaFiles(withPaths(small, small))).not.toThrow();
    expect(() => assertToastMediaFiles(withPaths(null, null))).not.toThrow();
    for (const path of [
      join(directory, "missing.png"),
      directory,
      large,
    ]) {
      expect(() => assertToastMediaFiles(withPaths(path, null))).toThrow(
        expect.objectContaining({
          code: "INVALID_ARGUMENT",
        }),
      );
      expect(() => assertToastMediaFiles(withPaths(null, path))).toThrow(
        expect.objectContaining({
          code: "INVALID_ARGUMENT",
        }),
      );
    }
  } finally {
    rmSync(directory, {
      recursive: true,
      force: true,
    });
  }
});
