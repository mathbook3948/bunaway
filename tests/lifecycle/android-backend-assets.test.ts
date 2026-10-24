import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { frameworkRoot } from "#cli/files";
import { deadline } from "../fixtures/deadlines.ts";
import {
  captureNativeChild,
  printNativeChildDiagnostics,
} from "../fixtures/native-child-diagnostics.ts";

// The two JVM starts take about 9s on a Windows runner and over 15s when it is under load, so each
// phase gets a shared deadline well above that and the test limit covers both.
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
    async function run(
      phase: "compile" | "harness",
      executable: string,
      args: string[],
      deadlineMs: number,
    ): Promise<string> {
      const diagnostics = resolve(
        frameworkRoot,
        "build/windows-matrix-logs/android-backend-assets",
        phase,
      );
      console.error(`Android backend assets ${phase}: ${executable}`);
      const child = Bun.spawn(
        [
          executable,
          ...args,
        ],
        {
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      try {
        const { stdout, stderr, exitCode } = await captureNativeChild(
          child,
          diagnostics,
          phase,
          deadlineMs,
        );
        expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
        return stdout;
      } catch (error) {
        await printNativeChildDiagnostics(diagnostics, root);
        throw error;
      }
    }
    try {
      await run(
        "compile",
        javac,
        [
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
        ],
        deadline("build"),
      );
      expect(
        await run(
          "harness",
          java,
          [
            "-cp",
            root,
            "dev.bunaway.host.BackendAssetsHarness",
            root,
          ],
          deadline("toolchain"),
        ),
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
  deadline("packagedAudit"),
);
