import { expect, test } from "bun:test";
import { resolve } from "node:path";

test.skipIf(process.platform !== "darwin")(
  "macOS storage uses real descriptors, permissions, transfers, races and process restart",
  async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        resolve(import.meta.dir, "macos-storage.ts"),
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [status, output, errors] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({
      status,
      errors,
    }).toEqual({
      status: 0,
      errors: "",
    });
    expect(output).toContain("native scenarios passed (source)");
  },
  60_000,
);
