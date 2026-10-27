import { expect, test } from "bun:test";
import type { NativeEnvironment } from "@bunaway/plugin";
import { BunawayError } from "@bunaway/protocol";
import { createUpdater } from "#plugins/updater/src/adapter";
import {
  isInsideFolder,
  isManagedByStore,
} from "#plugins/updater/src/platforms/windows-package-identity";

const PACKAGE_FOLDER =
  "C:\\Program Files\\WindowsApps\\Example.App_1.0.0.0_x64__abc";

function environment(): NativeEnvironment {
  return {
    dataRoot: "C:\\Data",
    capabilities: [],
    app: {
      id: "com.example.app",
      version: "1.0.0",
      pluginSettings: {
        updater: {
          endpoint: "https://updates.example.com/{{target}}/{{channel}}",
        },
      },
      launch: {
        mode: "packaged",
        executablePath: "C:\\App.exe",
        args: [],
      },
    },
  };
}

async function detailsOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(BunawayError);
    expect((error as BunawayError).code).toBe("UNSUPPORTED");
    return (error as BunawayError).details;
  }
  throw new Error("Expected the call to fail.");
}

test("an executable inside the package folder is matched case-insensitively", () => {
  expect(
    isInsideFolder(
      `${PACKAGE_FOLDER.toUpperCase()}\\App\\app.exe`,
      PACKAGE_FOLDER,
    ),
  ).toBe(true);
  expect(isInsideFolder(`${PACKAGE_FOLDER}\\`, PACKAGE_FOLDER)).toBe(true);
  expect(
    isInsideFolder(`${PACKAGE_FOLDER}-other\\app.exe`, PACKAGE_FOLDER),
  ).toBe(false);
  expect(isInsideFolder("C:\\Users\\me\\app.exe", PACKAGE_FOLDER)).toBe(false);
});

test("only a process with package identity and an executable inside the package is managed", () => {
  const managed = (packagePath: string | null, executable: string) =>
    isManagedByStore({
      packagePath: () => packagePath,
      executablePath: () => executable,
    });
  expect(managed(PACKAGE_FOLDER, `${PACKAGE_FOLDER}\\app.exe`)).toBe(true);
  // A sparse package gives identity to an executable outside the package folder.
  expect(managed(PACKAGE_FOLDER, "C:\\Apps\\Example\\app.exe")).toBe(false);
  expect(managed(null, `${PACKAGE_FOLDER}\\app.exe`)).toBe(false);
});

test("check and download fail with managedByStore before any request", async () => {
  let requests = 0;
  const instance = createUpdater("windows", "x64", environment(), {
    managedByStore: () => true,
    fetchImpl: (async () => {
      requests += 1;
      return new Response(null, {
        status: 204,
      });
    }) as unknown as typeof fetch,
  });
  expect(await detailsOf(instance.check())).toEqual({
    reason: "managedByStore",
  });
  expect(await detailsOf(instance.download())).toEqual({
    reason: "managedByStore",
  });
  expect(requests).toBe(0);
});

test("an install the app owns is checked as before and asked about once", async () => {
  let asked = 0;
  const instance = createUpdater("windows", "x64", environment(), {
    managedByStore: () => {
      asked += 1;
      return false;
    },
    fetchImpl: (async () =>
      new Response(null, {
        status: 204,
      })) as unknown as typeof fetch,
  });
  expect((await instance.check()).updateAvailable).toBe(false);
  await instance.check();
  expect(asked).toBe(1);
});
