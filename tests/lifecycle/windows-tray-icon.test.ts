import { expect, test } from "bun:test";
import { trayIco } from "../fixtures/tray-icon.ts";

test.skipIf(process.platform !== "win32")(
  "a tray created with a declared ICO reports a custom icon and releases it with the tray",
  async () => {
    const { Windows } = await import("#native/windows/bun/win32");
    const { Tray } = await import("#plugins/tray/src/platforms/windows-tray");
    const windows = new Windows(() => {});
    let tray: InstanceType<typeof Tray> | undefined;
    try {
      tray = new Tray(
        windows,
        "declared icon",
        () => {},
        undefined,
        undefined,
        undefined,
        undefined,
        trayIco().toString("base64"),
      );
      expect(tray.get().icon).toBe("custom");
      tray.setIcon(null);
      expect(tray.get().icon).toBe("app");
      tray.dispose();
      tray = undefined;
      expect(
        () =>
          new Tray(
            windows,
            "invalid icon",
            () => {},
            undefined,
            undefined,
            undefined,
            undefined,
            Buffer.from("not an icon").toString("base64"),
          ),
      ).toThrow();
      tray = new Tray(windows, "without icon", () => {});
      expect(tray.get().icon).toBe("app");
    } finally {
      try {
        tray?.dispose();
      } finally {
        windows.dispose();
      }
    }
  },
);

test.skipIf(process.platform !== "win32")(
  "the resources directory check follows Windows junctions, case and reserved names",
  async () => {
    const { mkdir, mkdtemp, rm, symlink, writeFile } = await import(
      "node:fs/promises"
    );
    const { tmpdir } = await import("node:os");
    const { resolve } = await import("node:path");
    const { readTrayIconFile } = await import(
      "#plugins/tray/src/platforms/windows-icon-file"
    );
    const base = await mkdtemp(resolve(tmpdir(), "bunaway-tray-icon-"));
    try {
      const root = resolve(base, "resources");
      const outside = resolve(base, "outside");
      await mkdir(resolve(root, "Icons"), {
        recursive: true,
      });
      await mkdir(outside);
      await writeFile(resolve(root, "Icons", "tray.ico"), trayIco());
      await writeFile(resolve(outside, "secret.ico"), trayIco());
      const expected = trayIco().toString("base64");
      expect(readTrayIconFile(root, "Icons/tray.ico")).toBe(expected);
      expect(readTrayIconFile(root, "icons\\TRAY.ICO")).toBe(expected);
      expect(readTrayIconFile(root.toUpperCase(), "Icons/tray.ico")).toBe(
        expected,
      );
      await symlink(outside, resolve(root, "linked"), "junction");
      expect(() => readTrayIconFile(root, "linked/secret.ico")).toThrow(
        "outside the resources directory",
      );
      for (const icon of [
        "Icons/CON",
        "Icons/nul.ico",
        "Icons/tray.ico::$DATA",
        "Icons/tray.ico.",
        "..\\outside\\secret.ico",
        "\\\\?\\C:\\Windows\\win.ini",
      ]) {
        expect(() => readTrayIconFile(root, icon)).toThrow("desktop.tray.icon");
      }
      expect(() => readTrayIconFile(root, "Icons")).toThrow("must be a file");
    } finally {
      await rm(base, {
        recursive: true,
        force: true,
      });
    }
  },
);
