import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineCLI } from "@bunaway/backend/cli";
import type { HostContext } from "@bunaway/protocol";
import { z } from "zod";
import { runWindowsApp } from "#native/windows/bun/entry";
import {
  forwardToInstance,
  instanceAddress,
  listenForInstances,
} from "#native/windows/bun/instance";
import { bundleNativeWorker } from "../fixtures/native-worker.ts";

const repo = process.argv.includes("--repo")
  ? process.argv[process.argv.indexOf("--repo") + 1]
  : resolve(import.meta.dir, "../..");
assert(repo);
const root = resolve(repo, "build/windows-cli-arguments");
if (!process.argv.includes("--child")) {
  await mkdir(root, {
    recursive: true,
  });
  const entry = await bundleNativeWorker(
    "windows-cli-arguments",
    root,
    import.meta.path,
  );
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      fileURLToPath(entry),
      "--child",
      "--repo",
      repo,
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
      timeout: 30_000,
      killSignal: "SIGKILL",
    },
  );
  const [output, errors, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  assert.equal(code, 0, `${output}\n${errors}`);
  assert(
    output.includes(
      "PASS: CLI initial/forwarded matches, help and error recovery through the real Windows host",
    ),
  );
  console.log(output.trim());
  await rm(root, {
    recursive: true,
    force: true,
  });
} else {
  const dataRoot = resolve(root, `data-${process.pid}`);
  await mkdir(dataRoot, {
    recursive: true,
  });
  const address = instanceAddress(dataRoot);
  const inbox = await listenForInstances(address);
  const cli = defineCLI({
    name: "memo",
    commands: {
      docs: {
        commands: {
          export: {
            options: {
              title: {
                type: "string",
                short: "t",
              },
              count: {
                type: "string",
              },
            },
            schema: z.strictObject({
              values: z.strictObject({
                title: z.string(),
                count: z.coerce.number().int().positive().default(1),
              }),
              positionals: z.array(z.string()),
            }),
          },
        },
      },
    },
  });
  const results: Awaited<ReturnType<typeof cli.parse>>[] = [];
  const sources: string[] = [];
  let failure: unknown;
  try {
    await runWindowsApp(
      {
        commands: {},
        events: {},
        desktop: {
          closeBehavior: "keep-alive",
          openArguments: "raw",
          async onOpen(request, desktop) {
            try {
              sources.push(request.source);
              assert.deepEqual(request.files, []);
              assert.deepEqual(request.urls, []);
              results.push(await cli.parse(request.argv));
              if (request.source === "initial") {
                await forwardToInstance(address, {
                  argv: [
                    "docs",
                    "export",
                    "--help",
                  ],
                  cwd: root,
                });
                await forwardToInstance(address, {
                  argv: [
                    "docs",
                    "export",
                    "--unknown",
                  ],
                  cwd: root,
                });
                await forwardToInstance(address, {
                  argv: [
                    "docs",
                    "export",
                    "-t",
                    '다시 열린 "😀"',
                    "--count=3",
                    "--",
                    "-draft.txt",
                    "https://",
                    "file:relative.txt",
                  ],
                  cwd: root,
                });
              }
              if (results.length === 4) {
                assert.equal(await desktop.quit(), true);
              }
            } catch (error) {
              failure = error;
              await desktop.quit();
            }
          },
        },
      },
      {
        runtime: {
          id: "cli-arguments-test",
          generation: crypto.randomUUID(),
        },
        backendContext: "cli-backend" as HostContext,
        assets: root,
        dataRoot,
        loader: resolve(
          repo,
          "build/cache/webview2/sdk/build/native/x64/WebView2Loader.dll",
        ),
        policy: {
          version: 1,
          backend: {
            permissions: [],
          },
          views: [],
        },
        windows: [],
      },
      {
        argv: [
          "docs",
          "export",
          "--title",
          "첫 실행 공백 😀",
          "--",
          "한글 file.txt",
          "https://",
          "file:relative.txt",
        ],
        cwd: root,
      },
      inbox,
    );
    if (failure !== undefined) {
      throw failure;
    }
    assert.deepEqual(sources, [
      "initial",
      "second-instance",
      "second-instance",
      "second-instance",
    ]);
    assert.deepEqual(results[0], {
      kind: "match",
      command: "docs export",
      data: {
        values: {
          title: "첫 실행 공백 😀",
          count: 1,
        },
        positionals: [
          "한글 file.txt",
          "https://",
          "file:relative.txt",
        ],
      },
    });
    assert.equal(results[1]?.kind, "help");
    assert.equal(results[2]?.kind, "error");
    assert.deepEqual(results[3], {
      kind: "match",
      command: "docs export",
      data: {
        values: {
          title: '다시 열린 "😀"',
          count: 3,
        },
        positionals: [
          "-draft.txt",
          "https://",
          "file:relative.txt",
        ],
      },
    });
    console.log(
      "PASS: CLI initial/forwarded matches, help and error recovery through the real Windows host",
    );
  } finally {
    await inbox.close();
  }
}
