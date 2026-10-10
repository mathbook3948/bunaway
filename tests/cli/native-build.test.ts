import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fetchDependency } from "#cli/native-build";

test("native dependencies verify cached content without accessing the download URL", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "bunaway-native-cache-"));
  try {
    const path = resolve(root, "cached");
    const content = "pinned executable";
    const digest = createHash("sha256").update(content).digest("hex");
    await writeFile(path, content);
    await fetchDependency("https://unused.invalid/dependency", path, digest);
    await writeFile(path, "corrupt executable");
    await expect(
      fetchDependency("https://unused.invalid/dependency", path, digest),
    ).rejects.toThrow("Hash mismatch");
    expect(await Bun.file(path).text()).toBe("corrupt executable");
    expect(await readdir(root)).toEqual([
      "cached",
    ]);
  } finally {
    await rm(root, {
      recursive: true,
      force: true,
    });
  }
});

test("verify-only and insecure downloads fail without creating cache files", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "bunaway-native-cache-"));
  try {
    const path = resolve(root, "missing/dependency");
    await expect(
      fetchDependency(
        "https://unused.invalid/dependency",
        path,
        "0".repeat(64),
        true,
      ),
    ).rejects.toThrow("Missing dependency");
    await expect(
      fetchDependency("http://unused.invalid/dependency", path, "0".repeat(64)),
    ).rejects.toThrow("HTTPS");
    expect(await readdir(root)).toEqual([]);
  } finally {
    await rm(root, {
      recursive: true,
      force: true,
    });
  }
});
