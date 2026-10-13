import { expect, test } from "bun:test";
import { resolve } from "node:path";

test.each([
  1,
  2,
  3,
])(
  "controls readiness waits for delayed browser acknowledgment and the current held command, document %s",
  async (count) => {
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        resolve(import.meta.dir, "fixtures/macos-webview-readiness.fixture.js"),
        String(count),
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
        timeout: 5000,
      },
    );
    const [output, errors, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code, `${output}\n${errors}`).toBe(0);
    expect(JSON.parse(output)).toEqual({
      count,
      delayedAckBlocked: true,
      loadingBlocked: true,
      navigated: true,
    });
  },
);
