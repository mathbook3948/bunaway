import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

test.skipIf(
  process.platform !== "win32" ||
    !existsSync(
      resolve(
        import.meta.dir,
        "../../build/cache/webview2/sdk/build/native/x64/WebView2Loader.dll",
      ),
    ),
)(
  "hidden HWND and real WebView2 preparation never show or activate, including transient WinEvents",
  async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        resolve(import.meta.dir, "windows-hidden-webview.fixture.ts"),
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code, stderr + stdout).toBe(0);
    expect(stdout).toContain(
      "zero show/activation/focus messages or WinEvents",
    );
  },
  65_000,
);
