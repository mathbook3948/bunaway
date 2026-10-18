import { expect, test } from "bun:test";
import { FILE_TYPE_ICON_PIXELS } from "#plugins/image/src/contract";
import { dispose, initialize } from "#plugins/image/src/platforms/windows";

/** Real shell and GDI: the lookup uses only the extension, never a file on disk. */
test.skipIf(process.platform !== "win32")(
  "file type icons are rendered by the Windows shell for each size and released on dispose",
  () => {
    const platform = initialize();
    try {
      for (const extension of [
        ".txt",
        ".png",
        ".zz9unregistered",
      ]) {
        for (const size of Object.keys(FILE_TYPE_ICON_PIXELS) as Array<
          keyof typeof FILE_TYPE_ICON_PIXELS
        >) {
          const created = platform.createFileTypeIcon({
            extension,
            size,
          });
          // Shell icon lists scale with display DPI, so the edge is at least the nominal size.
          expect(created.empty).toBe(false);
          expect(created.width).toBe(created.height);
          expect(created.width).toBeGreaterThanOrEqual(
            FILE_TYPE_ICON_PIXELS[size],
          );
          const pixels = platform.getPixels(created.id);
          const rgba = Buffer.from(pixels.rgba, "base64");
          expect(rgba.length).toBe(pixels.width * pixels.height * 4);
          let opaque = 0;
          for (let offset = 3; offset < rgba.length; offset += 4) {
            if (rgba[offset] !== 0) {
              opaque++;
            }
          }
          expect(opaque).toBeGreaterThan(0);
          expect(platform.remove(created.id)).toBe(true);
          expect(platform.remove(created.id)).toBe(false);
        }
      }
    } finally {
      dispose(platform);
      dispose(platform);
    }
  },
);
