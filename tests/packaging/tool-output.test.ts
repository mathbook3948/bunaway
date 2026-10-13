import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import { must, run } from "../../packages/packaging/src/tools.ts";

function args(code: number): string[] {
  return [
    "--no-env-file",
    "-e",
    `
      import {fstatSync} from "node:fs";
      if (!fstatSync(1).isFile() || !fstatSync(2).isFile()) {
        throw new Error("Helper requires regular output files");
      }
      console.log(" tool output ");
      console.error(" tool diagnostics ");
      process.exit(${code});
    `,
  ];
}

test.each([
  0,
  47,
])(
  "tool capture uses real regular files, preserves output and exit %s, and removes scratch files",
  async (code) => {
    const directory = await mkdtemp(resolve(tmpdir(), "bunaway-tool-test-"));
    try {
      expect(
        await run(process.execPath, args(code), {
          captureDirectory: directory,
        }),
      ).toEqual({
        code,
        stdout: "tool output",
        stderr: "tool diagnostics",
      });
      expect(await readdir(directory)).toEqual([]);
    } finally {
      await rm(directory, {
        recursive: true,
        force: true,
      });
    }
  },
);

test("file capture preserves must failure diagnostics and cleans up when process creation fails", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "bunaway-tool-test-"));
  try {
    await expect(
      must(process.execPath, args(47), {
        captureDirectory: directory,
      }),
    ).rejects.toThrow(
      `${basename(process.execPath)} exited 47: tool diagnostics`,
    );
    expect(await readdir(directory)).toEqual([]);
    await expect(
      run(resolve(directory, "missing-tool"), [], {
        captureDirectory: directory,
      }),
    ).rejects.toThrow();
    expect(await readdir(directory)).toEqual([]);
  } finally {
    await rm(directory, {
      recursive: true,
      force: true,
    });
  }
});
