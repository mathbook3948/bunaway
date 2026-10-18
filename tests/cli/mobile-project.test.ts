import { expect, test } from "bun:test";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { acquireBuildOutputLock } from "@bunaway/packaging";
import { frameworkRoot } from "#cli/files";
import { withMobileBuild } from "#cli/mobile-project";
import { deadline } from "../fixtures/deadlines.ts";

for (const target of [
  "android",
  "ios",
] as const) {
  test(`${target} build owns its lock and removes staging after success and failure`, async () => {
    const root = await mkdtemp(resolve(tmpdir(), "bunaway-mobile-build-"));
    let staging = "";
    try {
      const result = await withMobileBuild(
        root,
        target,
        async (work, signal) => {
          staging = work;
          expect(signal.aborted).toBe(false);
          await expect(acquireBuildOutputLock(root, target)).rejects.toThrow();
          await writeFile(resolve(work, "temporary"), "owned");
          return "published";
        },
      );
      expect(result).toBe("published");
      expect(await Bun.file(resolve(staging, "temporary")).exists()).toBe(
        false,
      );
      await expect(
        withMobileBuild(root, target, async (work) => {
          staging = work;
          await writeFile(resolve(work, "temporary"), "owned");
          throw new Error("build failed");
        }),
      ).rejects.toThrow("build failed");
      expect(await Bun.file(resolve(staging, "temporary")).exists()).toBe(
        false,
      );
      const release = await acquireBuildOutputLock(root, target);
      await release();
    } finally {
      await rm(root, {
        recursive: true,
        force: true,
      });
    }
  });

  test(`${target} cancellation reaches owned work and releases its lock and staging`, async () => {
    const root = await mkdtemp(resolve(tmpdir(), "bunaway-mobile-cancel-"));
    const ready = resolve(root, "ready.json");
    const cancel = resolve(root, "cancel.txt");
    const script = resolve(root, "cancel.ts");
    let child: ReturnType<typeof Bun.spawn> | undefined;
    try {
      await writeFile(
        script,
        `
        import { existsSync } from "node:fs";
        import { rename, writeFile } from "node:fs/promises";
        import { withMobileBuild } from ${JSON.stringify(resolve(frameworkRoot, "packages/cli/src/mobile-project.ts"))};
        // Windows process.kill terminates a process instead of delivering a console
        // event, so emit the same Node signal event there; POSIX sends a real signal.
        const timer = process.platform === "win32"
          ? setInterval(() => {
              if (existsSync(${JSON.stringify(cancel)})) {
                clearInterval(timer);
                process.emit("SIGTERM");
              }
            }, 20)
          : undefined;
        try {
          await withMobileBuild(${JSON.stringify(root)}, ${JSON.stringify(target)}, async (work, signal) => {
            await writeFile(${JSON.stringify(`${ready}.tmp`)}, JSON.stringify(work));
            await rename(${JSON.stringify(`${ready}.tmp`)}, ${JSON.stringify(ready)});
            signal.throwIfAborted();
            await new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), {once:true}));
          });
        } catch (error) {
          if (error instanceof Error && error.message.endsWith("build cancelled.")) process.exitCode = 41;
          else throw error;
        } finally {
          clearInterval(timer);
        }
      `,
      );
      child = Bun.spawn(
        [
          process.execPath,
          script,
        ],
        {
          stdout: "ignore",
          stderr: "pipe",
        },
      );
      const limit = Date.now() + deadline("childStep");
      while (!(await Bun.file(ready).exists()) && Date.now() < limit) {
        await Bun.sleep(10);
      }
      const staging: unknown = JSON.parse(await readFile(ready, "utf8"));
      if (typeof staging !== "string") {
        throw new Error("Missing owned staging path.");
      }
      if (process.platform === "win32") {
        await writeFile(cancel, "");
      } else {
        child.kill("SIGTERM");
      }
      expect(await child.exited).toBe(41);
      await expect(lstat(staging)).rejects.toMatchObject({
        code: "ENOENT",
      });
      // A new owner can acquire the same target only after signal cleanup has completed.
      const release = await acquireBuildOutputLock(root, target);
      await release();
    } finally {
      child?.kill();
      await child?.exited;
      await rm(root, {
        recursive: true,
        force: true,
      });
    }
  });
}
