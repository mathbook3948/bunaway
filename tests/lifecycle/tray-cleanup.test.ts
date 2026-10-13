import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

test("compiled Tray retains failed native releases and stops callbacks during repeated cleanup", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "bunaway-tray-cleanup-"));
  const platform = resolve(
    import.meta.dir,
    "../fixtures/tray-cleanup-platform.ts",
  );
  try {
    const result = await Bun.build({
      entrypoints: [
        resolve(import.meta.dir, "../fixtures/tray-cleanup.ts"),
      ],
      target: "bun",
      plugins: [
        {
          name: "controlled-tray-platform",
          setup(build) {
            build.onResolve(
              {
                filter: /(win32|win32-bindings|tray-icon|menu)\.ts$/,
              },
              () => ({
                path: platform,
              }),
            );
            build.onLoad(
              {
                filter: /[\\/]native[\\/]windows[\\/]bun[\\/]tray\.ts$/,
              },
              async (args) => ({
                // Replace only the native binding import; compile the actual resource owner unchanged.
                contents: (await Bun.file(args.path).text()).replace(
                  '"bun:ffi"',
                  JSON.stringify(platform),
                ),
                loader: "ts",
              }),
            );
          },
        },
      ],
    });
    expect(result.success, result.logs.map(String).join("\n")).toBe(true);
    const artifact = result.outputs[0];
    if (!artifact) {
      throw new Error("Missing tray cleanup fixture artifact");
    }
    const entry = resolve(directory, "cleanup.js");
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
    expect(await stdout).toContain(
      "PASS retryable tray cleanup and callback shutdown",
    );
  } finally {
    await rm(directory, {
      recursive: true,
      force: true,
    });
  }
});
