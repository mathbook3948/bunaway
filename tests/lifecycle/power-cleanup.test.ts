import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

test("compiled power adapter retries failed rollback handles despite public cleanup failures", async () => {
  const output = await mkdtemp(resolve(tmpdir(), "bunaway-power-cleanup-"));
  try {
    const entry = resolve(output, "cleanup.js");
    let substituted = false;
    const result = await Bun.build({
      entrypoints: [
        resolve(import.meta.dir, "../fixtures/power-cleanup.ts"),
      ],
      target: "bun",
      plugins: [
        {
          name: "controlled-power-ffi",
          setup(build) {
            build.onLoad(
              {
                filter:
                  /[\\/]power[\\/]src[\\/]platforms[\\/]windows-bindings\.ts$/,
              },
              async (args) => {
                substituted = true;
                return {
                  // Route the bindings while retaining the real adapter and handle owners.
                  contents: (await Bun.file(args.path).text()).replace(
                    '"bun:ffi"',
                    JSON.stringify(
                      resolve(
                        import.meta.dir,
                        "../fixtures/power-cleanup-ffi.ts",
                      ),
                    ),
                  ),
                  loader: "ts",
                };
              },
            );
          },
        },
      ],
    });
    expect(result.success, result.logs.map(String).join("\n")).toBe(true);
    expect(substituted).toBe(true);
    const artifact = result.outputs[0];
    expect(artifact).toBeDefined();
    if (!artifact) {
      throw new Error("Missing power cleanup fixture artifact.");
    }
    await writeFile(entry, new Uint8Array(await artifact.arrayBuffer()));
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        entry,
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const stdout = new Response(child.stdout).text();
    const stderr = new Response(child.stderr).text();
    expect(await child.exited, await stderr).toBe(0);
    expect(await stdout).toContain("PASS combined power cleanup failures");
  } finally {
    await rm(output, {
      recursive: true,
      force: true,
    });
  }
});
