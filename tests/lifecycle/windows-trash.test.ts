import { expect, test } from "bun:test";
import {
  link,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, parse, resolve } from "node:path";
import createOperationsDefinition from "#plugins/opener/src/index";
import { nativeFactory as createOperationsFactory } from "../fixtures/native-platform.ts";

const createOperations = createOperationsFactory(
  createOperationsDefinition,
  "windows",
);

/** Find only this test's recycle metadata; never empty or change another user's bin. */
async function recycledItem(path: string): Promise<
  | {
      info: string;
      data: string;
    }
  | undefined
> {
  const bin = join(parse(path).root, "$Recycle.Bin");
  for (const directory of await readdir(bin)) {
    const userBin = join(bin, directory);
    let entries: string[];
    try {
      entries = await readdir(userBin);
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error.code === "EACCES" ||
          error.code === "EPERM" ||
          error.code === "ENOTDIR")
      ) {
        continue;
      }
      throw error;
    }
    for (const entry of entries.filter((name) => name.startsWith("$I"))) {
      const info = join(userBin, entry);
      const contents = await readFile(info);
      // $I format 1 uses a fixed UTF-16 path; format 2 stores a character count first.
      const offset = contents.readBigUInt64LE(0) === 2n ? 28 : 24;
      const original = contents
        .subarray(offset)
        .toString("utf16le")
        .split("\0")[0];
      if (original === path) {
        return {
          info,
          data: join(userBin, `$R${entry.slice(2)}`),
        };
      }
    }
  }
}

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
