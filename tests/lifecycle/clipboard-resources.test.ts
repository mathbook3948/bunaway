import { expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

test("clipboard resource failures and cancellable retries use isolated Win32 bindings", async () => {
  const root = resolve(
    import.meta.dir,
    `../../build/clipboard-resources-${crypto.randomUUID()}`,
  );
  const replacement = resolve(import.meta.dir, "../fixtures/clipboard-ffi.ts");
  await mkdir(root, {
    recursive: true,
  });
  try {
    const build = await Bun.build({
      entrypoints: [
        resolve(import.meta.dir, "../fixtures/clipboard-resources.fixture.ts"),
      ],
      target: "bun",
      outdir: root,
      plugins: [
        {
          name: "clipboard-test-bindings",
          setup(builder) {
            builder.onLoad(
              {
                filter: /[\\/]clipboard[\\/]src[\\/]win32\.ts$/,
              },
              async (args) => ({
                contents: (await Bun.file(args.path).text()).replace(
                  '"bun:ffi"',
                  JSON.stringify(replacement),
                ),
                loader: "ts",
              }),
            );
          },
        },
      ],
    });
    expect(build.success).toBe(true);
    const child = Bun.spawn(
      [
        process.execPath,
        build.outputs[0]?.path ?? "",
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect({
      exit,
      stderr,
    }).toEqual({
      exit: 0,
      stderr: "",
    });
    expect(stdout).toContain(
      "ownership, failure, retry, cancellation and disposal passed",
    );
  } finally {
    await rm(root, {
      recursive: true,
      force: true,
    });
  }
});
