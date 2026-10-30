import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { deadline } from "../fixtures/deadlines.ts";

/** The fixture itself runs for the native fixture deadline; the test waits slightly longer for its report. */
const REPORT_GRACE_MS = 5000;

test.skipIf(process.platform !== "win32")(
  "Windows scheduled toast of an app id that has shown a toast arrives after the scheduling process exited",
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
  deadline("nativeFixture") + REPORT_GRACE_MS,
);
