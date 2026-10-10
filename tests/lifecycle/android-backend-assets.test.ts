import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { frameworkRoot } from "#cli/files";

// Windows PATH can select a standalone JRE. Use the compiler's JDK for both commands.
const javac = Bun.which(
  "javac",
  process.env.JAVA_HOME
    ? {
        PATH: resolve(process.env.JAVA_HOME, "bin"),
      }
    : {},
);
const java = javac
  ? Bun.which("java", {
      PATH: dirname(javac),
    })
  : null;

test.skipIf(!javac || !java)(
  "Android backend extraction replaces previous APK imports without removing app data",
  async () => {
    if (!javac || !java) {
      throw new Error("A JDK is required");
    }
    const root = await mkdtemp(resolve(tmpdir(), "bunaway-android-assets-"));
    async function run(executable: string, args: string[]): Promise<string> {
      const child = Bun.spawn(
        [
          executable,
          ...args,
        ],
        {
          stdout: "pipe",
          stderr: "pipe",
          timeout: 15000,
        },
      );
      const [output, errors, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(code, `${output}\n${errors}`).toBe(0);
      return output;
    }
    try {
      await run(javac, [
        "--release",
        "17",
        "-encoding",
        "UTF-8",
        "-d",
        root,
        resolve(
          frameworkRoot,
          "native/android/host/src/main/java/dev/bunaway/host/BackendAssets.java",
        ),
        resolve(
          frameworkRoot,
          "tests/fixtures/android/native/BackendAssetsHarness.java",
        ),
      ]);
      expect(
        await run(java, [
          "-cp",
          root,
          "dev.bunaway.host.BackendAssetsHarness",
          root,
        ]),
      ).toContain(
        "PASS: APK replacement, removed imports, app data preservation and failed extraction retry",
      );
    } finally {
      await rm(root, {
        recursive: true,
        force: true,
      });
    }
  },
  30000,
);
