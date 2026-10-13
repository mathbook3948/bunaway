import { expect, test } from "bun:test";
import {
  link,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join, parse, resolve } from "node:path";
import { createOperations } from "#plugins/opener/src/platforms/windows";
import { createFiles } from "#plugins/opener/src/windows-file";

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
  "Windows trashFile recycles a checked file and preserves linked companions",
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
      const call = (path: string) =>
        adapter.execute(
          "opener.trashFile",
          {
            path,
          },
          "backend",
        );
      expect(() => call(root)).toThrow(
        expect.objectContaining({
          code: "INVALID_ARGUMENT",
        }),
      );
      expect(() => call("\\\\server\\share\\file.txt")).toThrow(
        expect.objectContaining({
          code: "UNSUPPORTED",
        }),
      );
      const hardlink = `${sample}.link`;
      await link(sample, hardlink);
      expect(() => call(sample)).toThrow(
        expect.objectContaining({
          code: "PERMISSION_DENIED",
        }),
      );
      await unlink(hardlink);
      const alias = join(root, "alias");
      await symlink(companion, alias, "junction");
      expect(() => call(join(alias, "image.txt"))).toThrow(
        expect.objectContaining({
          code: "PERMISSION_DENIED",
        }),
      );
      expect(
        adapter.execute(
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
      expect(await readFile(join(companion, "image.txt"), "utf8")).toBe(
        "companion must survive",
      );
      expect(() =>
        adapter.execute(
          "opener.trashFile",
          {
            path: sample,
          },
          "backend",
        ),
      ).toThrow(
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

test.skipIf(process.platform !== "win32")(
  "Windows trash validation preserves parent pins and detects replaced leaf identity",
  async () => {
    const root = resolve("build", `windows-trash-race-${crypto.randomUUID()}`);
    await mkdir(root, {
      recursive: true,
    });
    const path = join(root, "file.txt");
    const moved = join(root, "moved.txt");
    await writeFile(path, "original");
    const files = createFiles();
    try {
      // The leaf shares delete for Shell recycling, while its parent stays pinned.
      files.withTrashFile(path, (verify) => {
        expect(verify).toBeFunction();
        verify();
      });
      // A synchronous rename is needed inside the same check-to-request boundary.
      const { renameSync, writeFileSync } = await import("node:fs");
      files.withTrashFile(path, (verify) => {
        expect(() => renameSync(root, `${root}-renamed`)).toThrow();
        renameSync(path, moved);
        writeFileSync(path, "replacement");
        expect(verify).toThrow(
          expect.objectContaining({
            code: "PERMISSION_DENIED",
          }),
        );
      });
      expect(await readFile(path, "utf8")).toBe("replacement");
      expect(await readFile(moved, "utf8")).toBe("original");
    } finally {
      files.dispose();
      files.dispose();
      await rm(root, {
        recursive: true,
        force: true,
      });
    }
  },
);
