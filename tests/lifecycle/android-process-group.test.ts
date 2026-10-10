import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { frameworkRoot } from "#cli/files";

const java = Bun.which("java");
const setsid = Bun.which("setsid");

test.skipIf(process.platform !== "linux" || !java || !setsid)(
  "Android process owner cleans real inherited Linux descendants and pipes across every exit path",
  async () => {
    if (!java || !setsid) {
      throw new Error("Java and setsid are required");
    }
    const root = await mkdtemp(resolve(tmpdir(), "bunaway-android-group-"));
    async function run(args: string[]): Promise<string> {
      const child = Bun.spawn(
        [
          java ?? "",
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
      await run([
        "com.sun.tools.javac.Main",
        "--release",
        "17",
        "-d",
        root,
        resolve(
          frameworkRoot,
          "native/android/host/src/main/java/dev/bunaway/host/ProcessGroup.java",
        ),
        resolve(
          frameworkRoot,
          "tests/fixtures/android/native/ProcessGroupHarness.java",
        ),
      ]);
      expect(
        await run([
          "-cp",
          root,
          "dev.bunaway.host.ProcessGroupHarness",
          setsid,
          root,
        ]),
      ).toContain(
        "PASS: gated startup, graceful/failed/forced group cleanup, descendants and pipes",
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
