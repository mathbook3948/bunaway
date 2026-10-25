import { readdir, readFile } from "node:fs/promises";
import { join, parse } from "node:path";

/** Find only this test's recycle metadata; never empty or change another user's bin. */
export async function recycledItem(path: string): Promise<
  | {
      info: string;
      data: string;
    }
  | undefined
> {
  const bin = join(parse(path).root, "$Recycle.Bin");
  let directories: string[];
  try {
    directories = await readdir(bin);
  } catch (error) {
    // A volume whose bin was never used has no `$Recycle.Bin` yet.
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  for (const directory of directories) {
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
