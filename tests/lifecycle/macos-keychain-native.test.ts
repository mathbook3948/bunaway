import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test.skipIf(process.platform !== "darwin")(
  "real macOS private Keychain and AES-GCM in shared Bun and ad-hoc compiled executables",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "bunaway-keychain-build-"));
    const source = resolve(
      import.meta.dir,
      "fixtures/macos-safe-storage-native.ts",
    );
    const executable = join(root, "safe-storage-fixture");
    const run = async (args: string[]) => {
      const child = Bun.spawn(args, {
        stdout: "pipe",
        stderr: "pipe",
        timeout: 60000,
      });
      const [output, errors, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(code, errors).toBe(0);
      return output;
    };
    try {
      expect(
        await run([
          process.execPath,
          "--no-env-file",
          source,
        ]),
      ).toContain('"mode":"shared-bun"');
      await run([
        process.execPath,
        "build",
        "--compile",
        source,
        "--outfile",
        executable,
      ]);
      await run([
        "/usr/bin/codesign",
        "--force",
        "--sign",
        "-",
        "--entitlements",
        resolve(import.meta.dir, "../../native/macos/bun/entitlements.plist"),
        executable,
      ]);
      expect(
        await run([
          executable,
        ]),
      ).toContain('"mode":"compiled"');
    } finally {
      await rm(root, {
        recursive: true,
        force: true,
      });
    }
  },
  180000,
);
