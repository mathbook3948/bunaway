import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  extractDependencyArchive,
  fetchDependency,
  prepareNativeBuild,
} from "#cli/native-build";

// Stored ZIP containing nested/dependency.txt, with no platform archive-creation dependency.
const dependencyArchive = Buffer.from(
  "UEsDBAoAAAAAAHVvSl29P779EgAAABIAAAAVAAAAbmVzdGVkL2RlcGVuZGVuY3kudHh0cGlubmVkIGRlcGVuZGVuY3kKUEsBAh4DCgAAAAAAdW9KXb0/vv0SAAAAEgAAABUAAAAAAAAAAAAAAKSBAAAAAG5lc3RlZC9kZXBlbmRlbmN5LnR4dFBLBQYAAAAAAQABAEMAAABFAAAAAAA=",
  "base64",
);

test.skipIf(process.platform !== "win32")(
  "Android preparation validates both ABI pins and cached artifacts",
  async () => {
    const root = await mkdtemp(resolve(tmpdir(), "bunaway-android-cache-"));
    const content = "pinned Android dependency";
    const digest = createHash("sha256").update(content).digest("hex");
    try {
      const pins = [];
      for (const [architecture, target] of [
        [
          "x64",
          "linux-x64-android-baseline",
        ],
        [
          "arm64",
          "linux-aarch64-android",
        ],
      ] as const) {
        const path = resolve(
          root,
          `runtime/build-manifests/android-${architecture}.json`,
        );
        const bun = {
          target,
          version: Bun.version,
          archiveUrl: "https://unused.invalid/bun.zip",
          archiveSha256: digest,
          executableSha256: digest,
          licenseUrl: "https://unused.invalid/LICENSE",
          licenseSha256: digest,
        };
        await Bun.write(
          path,
          JSON.stringify({
            bun,
          }),
        );
        pins.push({
          path,
          bun,
          cache: resolve(root, `build/cache/android-bun/${architecture}`),
        });
      }
      const arm64 = pins[1];
      if (!arm64) {
        throw new Error("Missing ARM64 fixture");
      }
      for (const invalid of [
        {
          target: "wrong-target",
        },
        {
          version: "0.0.0",
        },
      ]) {
        await Bun.write(
          arm64.path,
          JSON.stringify({
            bun: {
              ...arm64.bun,
              ...invalid,
            },
          }),
        );
        await expect(prepareNativeBuild("android", root)).rejects.toThrow();
        expect(await readdir(root)).toEqual([
          "runtime",
        ]);
      }
      await Bun.write(
        arm64.path,
        JSON.stringify({
          bun: arm64.bun,
        }),
      );
      await expect(prepareNativeBuild("android", root, true)).rejects.toThrow(
        "Missing dependency",
      );
      expect(await readdir(root)).toEqual([
        "runtime",
      ]);
      const artifacts = pins.flatMap(({ bun, cache }) => [
        resolve(cache, `bun-${bun.target}.zip`),
        resolve(cache, `bun-${bun.target}/bun`),
        resolve(cache, "LICENSE.bun"),
      ]);
      for (const path of artifacts) {
        await Bun.write(path, content);
      }
      await prepareNativeBuild("android", root, true);
      await prepareNativeBuild("android", root);
      for (const path of artifacts) {
        await Bun.write(path, "corrupt");
        await expect(prepareNativeBuild("android", root, true)).rejects.toThrow(
          "Hash mismatch",
        );
        await Bun.write(path, content);
      }
    } finally {
      await rm(root, {
        recursive: true,
        force: true,
      });
    }
  },
);

for (const directory of [
  ".",
  "sdk",
]) {
  test.skipIf(process.platform !== "win32" && process.platform !== "darwin")(
    `native ZIP extraction supports Unicode cache paths (${directory})`,
    async () => {
      const root = await mkdtemp(resolve(tmpdir(), "bunaway dependency 한글 "));
      try {
        const archive = resolve(root, "dependency.zip");
        const output = resolve(root, directory);
        await mkdir(output, {
          recursive: true,
        });
        await writeFile(archive, dependencyArchive);
        await extractDependencyArchive(archive, output);
        expect(
          await Bun.file(resolve(output, "nested/dependency.txt")).text(),
        ).toBe("pinned dependency\n");
        await writeFile(archive, "invalid archive");
        await expect(extractDependencyArchive(archive, output)).rejects.toThrow(
          "failed (exit",
        );
      } finally {
        await rm(root, {
          recursive: true,
          force: true,
        });
      }
    },
  );
}

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
