import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { win32 } from "node:path";
import path from "@bunaway/plugin-path/native/windows";
import { userDirectorySchema } from "../../plugins/path/src/contract.ts";

test.skipIf(process.platform !== "win32")(
  "Windows current-user known folders agree with the OS, preserve native DLL ownership and return fully qualified paths",
  async () => {
    const create = path._definition.nativePlatforms.windows?.create;
    if (!create) {
      throw new Error("Windows path adapter is missing.");
    }
    const adapter = create({
      dataRoot: "unused",
      capabilities: [],
    });
    const other = create({
      dataRoot: "unused",
      capabilities: [],
    });
    try {
      const directories: Record<string, string> = {};
      for (const directory of userDirectorySchema.options) {
        const value = await adapter.execute(
          "path.getDirectory",
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
      // .NET independently maps current-user shell folders, including redirection and missing folders.
      const output = execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "$ErrorActionPreference='Stop'; [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); @{ home=[Environment]::GetFolderPath('UserProfile','DoNotVerify'); documents=[Environment]::GetFolderPath('MyDocuments','DoNotVerify'); desktop=[Environment]::GetFolderPath('DesktopDirectory','DoNotVerify'); pictures=[Environment]::GetFolderPath('MyPictures','DoNotVerify'); music=[Environment]::GetFolderPath('MyMusic','DoNotVerify'); videos=[Environment]::GetFolderPath('MyVideos','DoNotVerify') } | ConvertTo-Json -Compress",
        ],
        {
          encoding: "utf8",
          windowsHide: true,
        },
      );
      const expected: unknown = JSON.parse(output);
      if (
        !expected ||
        typeof expected !== "object" ||
        Array.isArray(expected)
      ) {
        throw new Error("The OS oracle did not return directory paths.");
      }
      for (const [directory, path] of Object.entries(expected)) {
        const actual = directories[directory];
        if (typeof path !== "string" || actual === undefined) {
          throw new Error("The OS oracle returned an invalid directory path.");
        }
        expect(actual).toBe(path);
      }
      await adapter.dispose();
      await adapter.dispose();
      const home = directories.home;
      if (!home) {
        throw new Error("The home directory query returned no path.");
      }
      expect(
        await other.execute(
          "path.getDirectory",
          {
            directory: "home",
          },
          "backend",
        ),
      ).toBe(home);
      await expect(
        adapter.execute(
          "path.getDirectory",
          {
            directory: "home",
          },
          "backend",
        ),
      ).rejects.toMatchObject({
        code: "CANCELLED",
      });
    } finally {
      await adapter.dispose();
      await other.dispose();
    }
  },
);
