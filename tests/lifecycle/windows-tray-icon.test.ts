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
