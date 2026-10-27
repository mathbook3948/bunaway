import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { deadline, waitFor } from "../fixtures/deadlines.ts";
import { processExitProbe } from "../fixtures/process-exit-probe.ts";

// A compiled executable stands in for the packaged backend: `new Worker` for in-process work and
// `Bun.spawn({ ipc })` for a crash-isolated child, the two Bun features that stand in for
// Electron's utilityProcess. The Worker and IPC parts run on every host; the app Job Object part
// needs Windows. See docs/decisions/0102-utility-process-bun-mapping.md.
setDefaultTimeout(deadline("build") + deadline("childStep"));

const fixtures = resolve(import.meta.dir, "fixtures");

async function compileApp(root: string): Promise<string> {
  const executable = resolve(
    root,
    process.platform === "win32" ? "utility app.exe" : "utility-app",
  );
  const build = Bun.spawn(
    [
      process.execPath,
      "build",
      "--compile",
      `--outfile=${executable}`,
      resolve(fixtures, "utility-process-app.ts"),
      resolve(fixtures, "utility-process-worker.ts"),
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [out, err, code] = await Promise.all([
    new Response(build.stdout).text(),
    new Response(build.stderr).text(),
    build.exited,
  ]);
  expect(code, `${out}${err}`).toBe(0);
  return executable;
}

async function freshRoot(): Promise<string> {
  const root = resolve(
    import.meta.dir,
    `../../build/windows-utility-process-${crypto.randomUUID()}`,
  );
  await mkdir(root, {
    recursive: true,
  });
  return root;
}

function events(text: string): Record<string, unknown>[] {
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

test("a compiled backend runs a Worker and a Bun.spawn IPC child with messages, errors and exit codes", async () => {
  const root = await freshRoot();
  try {
    const executable = await compileApp(root);
    const app = Bun.spawn(
      [
        executable,
      ],
      {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [out, err, code] = await Promise.all([
      new Response(app.stdout).text(),
      new Response(app.stderr).text(),
      app.exited,
    ]);
    expect(code, `${out}${err}`).toBe(0);
    const reported = Object.assign({}, ...events(out));
    // Worker: request and reply messages, and an uncaught worker error reaches onerror.
    expect(reported.worker).toBe(42);
    expect(String(reported.workerError)).toContain("worker failure");
    // Child: a separate process, a message each way, and its exit code reaches onExit.
    expect(reported.childDistinct).toBe(true);
    expect(reported.child).toEqual({
      echoed: {
        echo: "hello",
      },
    });
    expect(reported.childExit).toEqual({
      code: 3,
      signal: null,
    });
    expect(reported.parentAlive).toBe(true);
  } finally {
    await rm(root, {
      recursive: true,
      force: true,
    });
  }
});

test.skipIf(process.platform !== "win32")(
  "an IPC child started by the app process ends with the app because it joins the app Job Object",
  async () => {
    const root = await freshRoot();
    const release = resolve(root, "release");
    try {
      const executable = await compileApp(root);
      const app = Bun.spawn(
        [
          executable,
        ],
        {
          cwd: root,
          env: {
            ...process.env,
            BUNAWAY_FIXTURE_ROLE: "contain",
            BUNAWAY_FIXTURE_DATA: resolve(root, "data"),
            BUNAWAY_FIXTURE_RELEASE: release,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const lines = (async () => {
        let text = "";
        for await (const chunk of app.stdout) {
          text += Buffer.from(chunk).toString();
          const found = events(text).find((event) => "lingerPid" in event);
          if (found) {
            return Number(found.lingerPid);
          }
        }
        throw new Error(`The app exited before reporting its child: ${text}`);
      })();
      const pid = await lines;
      const child = processExitProbe(pid);
      try {
        expect(child.exited()).toBe(false);
        await writeFile(release, "");
        expect(await app.exited).toBe(0);
        await waitFor(() => child.exited(), {
          deadline: "childExit",
          what: "the IPC child to end with the app Job Object",
        });
      } finally {
        child.dispose();
      }
    } finally {
      await rm(root, {
        recursive: true,
        force: true,
      });
    }
  },
);
