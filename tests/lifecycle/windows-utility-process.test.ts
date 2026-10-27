import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { deadline, killAfter, waitFor } from "../fixtures/deadlines.ts";
import { processExitProbe } from "../fixtures/process-exit-probe.ts";

// A compiled executable with one entry point stands in for the packaged backend: `new Worker` for
// in-process work and `Bun.spawn({ ipc })` for a crash-isolated child, the two Bun features that
// stand in for Electron's utilityProcess. The Worker and IPC parts run on every host; the app Job
// Object part needs Windows. See docs/decisions/0102-utility-process-bun-mapping.md.
setDefaultTimeout(deadline("build") + deadline("childStep"));

const fixtures = resolve(import.meta.dir, "fixtures");
let root = "";
let executable = "";

beforeAll(async () => {
  root = resolve(
    import.meta.dir,
    `../../build/windows-utility-process-${crypto.randomUUID()}`,
  );
  await mkdir(root, {
    recursive: true,
  });
  executable = resolve(
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
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const timer = killAfter(build, "build");
  const [out, err, code] = await Promise.all([
    new Response(build.stdout).text(),
    new Response(build.stderr).text(),
    build.exited,
  ]);
  clearTimeout(timer);
  expect(code, `${out}${err}`).toBe(0);
});

afterAll(async () => {
  await rm(root, {
    recursive: true,
    force: true,
  });
});

function startApp(role: string, extra: Record<string, string> = {}) {
  return Bun.spawn(
    [
      executable,
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        BUNAWAY_FIXTURE_ROLE: role,
        BUNAWAY_FIXTURE_SCRIPTS: fixtures,
        ...extra,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
}

function events(text: string): Record<string, unknown>[] {
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

test("a compiled backend runs Workers and a Bun.spawn IPC child with messages, errors and exit codes", async () => {
  const app = startApp("app");
  const timer = killAfter(app, "childStep");
  const [out, err, code] = await Promise.all([
    new Response(app.stdout).text(),
    new Response(app.stderr).text(),
    app.exited,
  ]);
  clearTimeout(timer);
  expect(code, `${out}${err}`).toBe(0);
  const reported = Object.assign({}, ...events(out));
  // Worker from a script file and from a Blob URL: request and reply, and an uncaught worker
  // error reaches onerror.
  for (const label of [
    "worker",
    "blobWorker",
  ]) {
    expect(reported[label]).toBe(42);
    expect(String(reported[`${label}Error`])).toContain("worker failure");
  }
  // Child: a separate plain Bun process, a message each way, and its exit code reaches onExit.
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
});

test.skipIf(process.platform !== "win32")(
  "an IPC child started by the app process ends with the app because it joins the app Job Object",
  async () => {
    const release = resolve(root, "release");
    const app = startApp("contain", {
      BUNAWAY_FIXTURE_DATA: resolve(root, "data"),
      BUNAWAY_FIXTURE_RELEASE: release,
    });
    const timer = killAfter(app, "nativeFixture");
    // Nothing reads stderr until the end, so collect it from the start to keep the pipe drained.
    const stderr = new Response(app.stderr).text();
    try {
      let text = "";
      let pid = 0;
      for await (const chunk of app.stdout) {
        text += Buffer.from(chunk).toString();
        const found = events(text).find((event) => "lingerPid" in event);
        if (found) {
          pid = Number(found.lingerPid);
          break;
        }
      }
      if (pid === 0) {
        // The app is still running here, so stderr only completes after it is killed.
        app.kill();
        throw new Error(
          `The app did not report its child: ${text}${await stderr}`,
        );
      }
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
      clearTimeout(timer);
      app.kill();
    }
  },
);
