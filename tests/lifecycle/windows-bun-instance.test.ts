import { expect, test } from "bun:test";
import { resolve } from "node:path";

test.skipIf(process.platform !== "win32")(
  "app data ownership rejects duplicates and recovers after normal exit or termination",
  async () => {
    const root = resolve(
      import.meta.dir,
      `../../build/windows-instance-${crypto.randomUUID()}`,
    );
    const module = new URL("../../native/windows/bun/job.ts", import.meta.url)
      .href;
    const children: ReturnType<typeof Bun.spawn>[] = [];
    const start = (dataRoot: string, hold = false) => {
      const child = Bun.spawn(
        [
          process.execPath,
          "--no-env-file",
          "-e",
          `import { containAppProcess } from ${JSON.stringify(module)};
           containAppProcess(${JSON.stringify(dataRoot)});
           containAppProcess(${JSON.stringify(dataRoot)});
           console.log("owned");
           ${hold ? "await Bun.stdin.text();" : ""}`,
        ],
        {
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      children.push(child);
      return child;
    };
    const owns = async (child: ReturnType<typeof start>) => {
      const reader = child.stdout.getReader();
      try {
        expect(new TextDecoder().decode((await reader.read()).value)).toContain(
          "owned",
        );
      } finally {
        reader.releaseLock();
      }
    };
    const timer = setTimeout(() => {
      for (const child of children) {
        if (child.exitCode === null) {
          child.kill();
        }
      }
    }, 10000);
    try {
      const owner = start(root, true);
      await owns(owner);
      const duplicate = start(root.toUpperCase());
      const error = new Response(duplicate.stderr).text();
      expect(await duplicate.exited).not.toBe(0);
      expect(await error).toContain("App data directory is already in use.");
      expect(owner.exitCode).toBeNull();
      const independent = start(`${root}-other`);
      expect(await independent.exited).toBe(0);
      owner.stdin.end();
      expect(await owner.exited).toBe(0);
      const restarted = start(root, true);
      await owns(restarted);
      restarted.kill();
      await restarted.exited;
      const recovered = start(root);
      expect(await recovered.exited).toBe(0);
    } finally {
      clearTimeout(timer);
      for (const child of children) {
        if (child.exitCode === null) {
          child.kill();
        }
      }
      await Promise.all(children.map((child) => child.exited));
    }
  },
  15000,
);
