import { expect, test } from "bun:test";
import { win32 } from "node:path";
import path from "@bunaway/plugin-path/native/windows";
import { appDirectorySchema } from "../../plugins/path/src/contract.ts";

const APP_ID = "windows-path-app-directories";

/** Case-insensitive prefix check for Windows paths. */
function isInside(parent: string | undefined, child: string): boolean {
  if (!parent) {
    return false;
  }
  const relative = win32.relative(parent, child);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith("..\\") &&
    !win32.isAbsolute(relative)
  );
}

test.skipIf(process.platform !== "win32")(
  "Windows app directories are absolute, use the host app id and sit under APPDATA and LOCALAPPDATA",
  async () => {
    const create = path._definition.nativePlatforms.windows?.create;
    if (!create) {
      throw new Error("Windows path adapter is missing.");
    }
    const localAppData = process.env.LOCALAPPDATA;
    const dataRoot = win32.join(localAppData ?? "", "bunaway", APP_ID);
    const adapter = create({
      app: {
        id: APP_ID,
        launch: {
          mode: "development",
          executablePath: process.execPath,
          args: [],
        },
      },
      dataRoot,
      capabilities: [],
    });
    try {
      const directories: Record<string, string> = {};
      for (const directory of appDirectorySchema.options) {
        const value = await adapter.execute(
          "path.getAppDirectory",
          {
            directory,
          },
          "backend",
        );
        if (typeof value !== "string") {
          throw new Error("Directory must be a path string.");
        }
        expect(win32.isAbsolute(value)).toBe(true);
        directories[directory] = value;
      }
      const roaming = win32.join(process.env.APPDATA ?? "", "bunaway", APP_ID);
      expect(directories.appConfig).toBe(roaming);
      expect(directories.appData).toBe(roaming);
      expect(isInside(process.env.APPDATA, roaming)).toBe(true);
      for (const directory of [
        "appLocalData",
        "cache",
        "logs",
      ]) {
        expect(isInside(localAppData, directories[directory] ?? "")).toBe(true);
        expect(isInside(dataRoot, directories[directory] ?? "")).toBe(true);
      }
      // The log plugin writes to <dataRoot>\logs, and nothing returned is the host-owned root.
      expect(directories.logs).toBe(win32.join(dataRoot, "logs"));
      expect(Object.values(directories)).not.toContain(dataRoot);
      // temp is the per-user system directory, reported without a trailing separator.
      expect(directories.temp?.toLowerCase()).toBe(
        (process.env.TEMP ?? process.env.TMP ?? "")
          .replace(/[\\/]+$/, "")
          .toLowerCase(),
      );
    } finally {
      await adapter.dispose();
    }
  },
);
