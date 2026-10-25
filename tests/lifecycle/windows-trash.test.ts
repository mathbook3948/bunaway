import { expect, test } from "bun:test";
import { link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import createOperationsDefinition from "#plugins/opener/src/index";
import { nativeFactory as createOperationsFactory } from "../fixtures/native-platform.ts";
import { recycledItem } from "../fixtures/windows-recycle-bin.ts";

const createOperations = createOperationsFactory(
  createOperationsDefinition,
  "windows",
);

test.skipIf(process.platform !== "win32")(
  "Windows trashFile recycles one name of a file and preserves its other names and companions",
  async () => {
    const root = resolve("build", `windows-trash-${crypto.randomUUID()}`);
    await mkdir(root, {
      recursive: true,
    });
    const sample = join(root, "한글 공백, 😀.html");
    const companion = join(root, "한글 공백, 😀_files");
    await mkdir(companion);
    await writeFile(join(companion, "image.txt"), "companion must survive");
    await writeFile(sample, "recycle content");
    const adapter = createOperations({
      dataRoot: root,
      capabilities: [],
    });
    try {
      const call = async (path: string) =>
        await adapter.execute(
          "opener.trashFile",
          {
            path,
          },
          "backend",
        );
      await expect(call(root)).rejects.toThrow(
        expect.objectContaining({
          code: "INVALID_ARGUMENT",
        }),
      );
      await expect(call("\\\\server\\share\\file.txt")).rejects.toThrow(
        expect.objectContaining({
          code: "UNSUPPORTED",
        }),
      );
      // Another name of the same file is not rejected; only the requested name is recycled.
      const hardlink = `${sample}.link`;
      await link(sample, hardlink);
      expect(
        await adapter.execute(
          "opener.trashFile",
          {
            path: sample,
          },
          "backend",
        ),
      ).toBeNull();
      expect(await Bun.file(sample).exists()).toBe(false);
      const item = await recycledItem(sample);
      expect(item).toBeDefined();
      if (!item) {
        throw new Error("Test file has no Recycle Bin metadata.");
      }
      expect(await readFile(item.data, "utf8")).toBe("recycle content");
      expect(await readFile(hardlink, "utf8")).toBe("recycle content");
      expect(await readFile(join(companion, "image.txt"), "utf8")).toBe(
        "companion must survive",
      );
      await expect(
        adapter.execute(
          "opener.trashFile",
          {
            path: sample,
          },
          "backend",
        ),
      ).rejects.toThrow(
        expect.objectContaining({
          code: "INVALID_ARGUMENT",
          details: {
            reason: "FILE_NOT_FOUND",
          },
        }),
      );
    } finally {
      await adapter.dispose();
      // Targeted cleanup of this test's recycled file and metadata only.
      const item = await recycledItem(sample);
      if (item) {
        await rm(item.data);
        await rm(item.info);
      }
      await rm(root, {
        recursive: true,
        force: true,
      });
    }
  },
  15000,
);
