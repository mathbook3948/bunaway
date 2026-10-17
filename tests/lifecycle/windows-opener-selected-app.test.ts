import { expect, test } from "bun:test";
import { link, mkdir, readdir, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import createOperationsDefinition from "#plugins/opener/src/index";
import { nativeFactory as createOperationsFactory } from "../fixtures/native-platform.ts";

const createOperations = createOperationsFactory(
  createOperationsDefinition,
  "windows",
);

test.skipIf(process.platform !== "win32")(
  "selected-app opener validates both pinned files before dispatch and cleans up failures",
  async () => {
    const root = resolve(
      import.meta.dir,
      `../../build/windows-opener-selected-${crypto.randomUUID()}`,
    );
    await mkdir(root, {
      recursive: true,
    });
    const home = await realpath(root);
    const app = resolve(home, "fake.exe");
    const target = resolve(home, "공백 값.txt");
    const linkedApp = resolve(home, "linked.exe");
    await Bun.write(app, "not executable");
    await Bun.write(target, "selected file");
    const adapter = createOperations({
      dataRoot: home,
      capabilities: [],
    });
    const call = async (
      name: string,
      payload:
        | {
            app: string;
            path: string;
          }
        | {
            app: string;
            url: string;
          },
    ) => await adapter.execute(name, payload, "backend");
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        await expect(
          call("opener.openUrlWith", {
            app: `${app}.missing.exe`,
            url: "https://example.com/",
          }),
        ).rejects.toThrow(
          expect.objectContaining({
            code: "INVALID_ARGUMENT",
            details: {
              reason: "FILE_NOT_FOUND",
            },
          }),
        );
        await expect(
          call("opener.openFileWith", {
            app,
            path: `${target}.missing`,
          }),
        ).rejects.toThrow(
          expect.objectContaining({
            code: "INVALID_ARGUMENT",
            details: {
              reason: "FILE_NOT_FOUND",
            },
          }),
        );
        await expect(
          call("opener.openFileWith", {
            app,
            path: home,
          }),
        ).rejects.toThrow(
          expect.objectContaining({
            code: "INVALID_ARGUMENT",
          }),
        );
        await expect(
          call("opener.openUrlWith", {
            app: target,
            url: "https://example.com/",
          }),
        ).rejects.toThrow(
          expect.objectContaining({
            code: "INVALID_ARGUMENT",
          }),
        );
      }
      await link(app, linkedApp);
      await expect(
        call("opener.openUrlWith", {
          app,
          url: "https://example.com/",
        }),
      ).rejects.toThrow(
        expect.objectContaining({
          code: "PERMISSION_DENIED",
        }),
      );
      await rm(linkedApp);
      // Failed checks must release both application and target handles.
      await rm(app);
      await rm(target);
      await adapter.dispose();
      await adapter.dispose();
      await expect(
        call("opener.openUrlWith", {
          app,
          url: "https://example.com/",
        }),
      ).rejects.toThrow(
        expect.objectContaining({
          code: "CANCELLED",
        }),
      );
    } finally {
      await adapter.dispose();
      await rm(root, {
        recursive: true,
        force: true,
      });
    }
  },
);

const RECENT_POLL_ATTEMPTS = 50;
const RECENT_POLL_INTERVAL_MS = 100;

/** Poll the user's Recent folder, since the Shell writes the shortcut asynchronously. */
async function waitForRecentShortcut(
  name: string,
  expected: boolean,
): Promise<boolean> {
  const recent = join(
    process.env.APPDATA ?? "",
    "Microsoft",
    "Windows",
    "Recent",
  );
  for (let attempt = 0; attempt < RECENT_POLL_ATTEMPTS; attempt++) {
    const present = (await readdir(recent)).includes(`${name}.lnk`);
    if (present === expected) {
      return true;
    }
    await Bun.sleep(RECENT_POLL_INTERVAL_MS);
  }
  return false;
}

test.skipIf(process.platform !== "win32")(
  "recent documents add a file to the Shell list, clear it and reject invalid targets",
  async () => {
    const root = resolve(
      import.meta.dir,
      `../../build/windows-opener-recent-${crypto.randomUUID()}`,
    );
    await mkdir(root, {
      recursive: true,
    });
    const name = `최근 문서 ${crypto.randomUUID()}.txt`;
    const target = join(root, name);
    await Bun.write(target, "recent document");
    const adapter = createOperations({
      dataRoot: root,
      capabilities: [],
    });
    const call = async (operation: string, payload: object) =>
      await adapter.execute(operation, payload, "backend");
    try {
      await expect(
        call("opener.addRecentDocument", {
          path: `${target}.missing`,
        }),
      ).rejects.toThrow(
        expect.objectContaining({
          code: "INVALID_ARGUMENT",
          details: {
            reason: "FILE_NOT_FOUND",
          },
        }),
      );
      for (const path of [
        root,
        "relative.txt",
      ]) {
        await expect(
          call("opener.addRecentDocument", {
            path,
          }),
        ).rejects.toThrow(
          expect.objectContaining({
            code: "INVALID_ARGUMENT",
          }),
        );
      }

      expect(
        await call("opener.addRecentDocument", {
          path: target,
        }),
      ).toBeNull();
      expect(await waitForRecentShortcut(name, true)).toBe(true);

      expect(await call("opener.clearRecentDocuments", {})).toBeNull();
      expect(await waitForRecentShortcut(name, false)).toBe(true);

      await adapter.dispose();
      await adapter.dispose();
      await expect(call("opener.clearRecentDocuments", {})).rejects.toThrow(
        expect.objectContaining({
          code: "CANCELLED",
        }),
      );
    } finally {
      await adapter.dispose();
      await rm(root, {
        recursive: true,
        force: true,
      });
    }
  },
  60_000,
);
