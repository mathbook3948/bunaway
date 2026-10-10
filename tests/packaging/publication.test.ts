import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  publishOwnedDirectory,
  PublishedDirectoryCleanupError,
  BUILD_TARGETS,
  OUTPUT_TARGETS,
} from "@bunaway/packaging";

test("publication restores previous output and preserves both errors when rollback fails", async () => {
  const root = await fs.mkdtemp(resolve(tmpdir(), "bunaway-publication-"));
  const source = resolve(root, "staged");
  const output = resolve(root, "output");
  const rename = fs.rename;
  const failure = new Error("Publication failed");
  const rollbackFailure = new Error("Rollback failed");
  try {
    await fs.mkdir(source);
    await fs.mkdir(output);
    await fs.writeFile(resolve(output, "old.txt"), "previous output");
    for (const rollbackFails of [
      false,
      true,
    ]) {
      const intercepted = spyOn(fs, "rename").mockImplementation(
        async (from, to) => {
          if (from === source) {
            throw failure;
          }
          if (rollbackFails && String(from).includes(".previous-")) {
            throw rollbackFailure;
          }
          await rename(from, to);
        },
      );
      try {
        if (rollbackFails) {
          try {
            await publishOwnedDirectory(root, source, output);
            throw new Error("Expected failure");
          } catch (error) {
            expect(error).toBeInstanceOf(AggregateError);
            if (!(error instanceof AggregateError)) {
              throw error;
            }
            expect(error.errors).toEqual([
              failure,
              rollbackFailure,
            ]);
            expect(error.cause).toBe(failure);
            const backup = (await fs.readdir(root)).find((name) =>
              name.startsWith("output.previous-"),
            );
            expect(backup).toBeDefined();
            expect(
              await fs.readFile(resolve(root, backup ?? "", "old.txt"), "utf8"),
            ).toBe("previous output");
          }
        } else {
          await expect(
            publishOwnedDirectory(root, source, output),
          ).rejects.toBe(failure);
          expect(await fs.readFile(resolve(output, "old.txt"), "utf8")).toBe(
            "previous output",
          );
        }
      } finally {
        intercepted.mockRestore();
      }
    }
  } finally {
    await fs.rm(root, {
      recursive: true,
      force: true,
    });
  }
});

test("publication reports cleanup failure as committed and leaves the old directory recoverable", async () => {
  const root = await fs.mkdtemp(resolve(tmpdir(), "bunaway-published-"));
  const source = resolve(root, "staged");
  const output = resolve(root, "output");
  const rm = fs.rm;
  try {
    await fs.mkdir(source);
    await fs.mkdir(output);
    await fs.writeFile(resolve(source, "new.txt"), "new output");
    await fs.writeFile(resolve(output, "old.txt"), "previous output");
    const intercepted = spyOn(fs, "rm").mockImplementation(
      async (path, options) => {
        if (String(path).includes(".previous-")) {
          throw new Error("Cleanup failed");
        }
        await rm(path, options);
      },
    );
    try {
      await expect(
        publishOwnedDirectory(root, source, output),
      ).rejects.toBeInstanceOf(PublishedDirectoryCleanupError);
    } finally {
      intercepted.mockRestore();
    }
    expect(await fs.readFile(resolve(output, "new.txt"), "utf8")).toBe(
      "new output",
    );
    expect(
      (await fs.readdir(root)).some((name) =>
        name.startsWith("output.previous-"),
      ),
    ).toBe(true);
  } finally {
    await fs.rm(root, {
      recursive: true,
      force: true,
    });
  }
});

test("Android reserves output without becoming a packaging build target", () => {
  expect([
    ...BUILD_TARGETS,
  ]).toEqual([
    "windows-x64",
    "macos-arm64",
  ]);
  expect(OUTPUT_TARGETS).toContain("android");
});
