import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { deadline } from "../fixtures/deadlines.ts";

test.skipIf(process.platform !== "win32")(
  "Windows scheduled toast arrives after the scheduling process exited",
  async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        fileURLToPath(
          new URL(
            "../fixtures/windows-toast-scheduled-exit.fixture.ts",
            import.meta.url,
          ),
        ),
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
        timeout: deadline("nativeFixture"),
      },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code, `${stdout}\n${stderr}`).toBe(0);
  },
  deadline("nativeFixture") + 5000,
);
