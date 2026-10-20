import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

for (const mode of [
  "marshal",
  "delivery",
  "activation",
]) {
  test.skipIf(process.platform !== "win32")(
    `Windows toast ${mode} uses real COM and controlled fixture resources`,
    async () => {
      const child = Bun.spawn(
        [
          process.execPath,
          "--no-env-file",
          fileURLToPath(
            new URL("../fixtures/windows-toast.fixture.ts", import.meta.url),
          ),
          mode,
        ],
        {
          stdout: "pipe",
          stderr: "pipe",
          timeout: 90000,
        },
      );
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(code, `${stdout}\n${stderr}`).toBe(0);
    },
    95000,
  );
}
