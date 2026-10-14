import { expect, test } from "bun:test";
import { link, mkdir, realpath, rm } from "node:fs/promises";
import { resolve } from "node:path";
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
