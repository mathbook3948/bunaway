import { dlopen } from "bun:ffi";
import { expect, test } from "bun:test";
import { mkdir, rename, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const WAIT_OBJECT_0 = 0;
const WAIT_TIMEOUT = 258;
const PROCESS_TERMINATE = 0x0001;
const SYNCHRONIZE = 0x00100000;

function hasExplorerDesktop(): boolean {
  if (process.platform !== "win32") {
    return false;
  }
  const user = dlopen("user32.dll", {
    GetShellWindow: {
      args: [],
      returns: "u64",
    },
  });
  try {
    return user.symbols.GetShellWindow() !== 0n;
  } finally {
    user.close();
  }
}

test.skipIf(!hasExplorerDesktop())(
  "Explorer launches outside the app Job and the launched process survives app exit",
  async () => {
    const root = resolve(
      import.meta.dir,
      `../../build/windows-opener-job-${crypto.randomUUID()}`,
    );
    await mkdir(root, {
      recursive: true,
    });
    const source = resolve(root, "helper.ts");
    const executable = resolve(root, "helper 한글.exe");
    const marker = `${executable}.json`;
    const stop = `${executable}.stop`;
    const ready = resolve(root, "ready");
    const release = resolve(root, "release");
    const launcherPath = resolve(root, "launcher.ts");
    const operationsModule = pathToFileURL(
      resolve(import.meta.dir, "../../plugins/opener/src/windows.ts"),
    ).href;
    const jobModule = pathToFileURL(
      resolve(import.meta.dir, "../../native/windows/bun/job.ts"),
    ).href;
    const kernel = dlopen("kernel32.dll", {
      OpenProcess: {
        args: [
          "u32",
          "i32",
          "u32",
        ],
        returns: "u64",
      },
      WaitForSingleObject: {
        args: [
          "u64",
          "u32",
        ],
        returns: "u32",
      },
      TerminateProcess: {
        args: [
          "u64",
          "u32",
        ],
        returns: "i32",
      },
      CloseHandle: {
        args: [
          "u64",
        ],
        returns: "i32",
      },
    });
    let handle = 0n;
    let launcher: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
    let output: Promise<string> | undefined;
    let errors: Promise<string> | undefined;
    try {
      await Bun.write(
        source,
        `
import { rename } from "node:fs/promises";
await Bun.write(${JSON.stringify(`${marker}.tmp`)}, JSON.stringify({ pid: process.pid }));
await rename(${JSON.stringify(`${marker}.tmp`)}, ${JSON.stringify(marker)});
const deadline = Date.now() + 30000;
while (!(await Bun.file(${JSON.stringify(stop)}).exists())) {
  if (Date.now() > deadline) process.exit(1);
  await Bun.sleep(20);
}
`,
      );
      const compiled = resolve(root, "helper.exe");
      const compiler = Bun.spawn(
        [
          process.execPath,
          "build",
          "--compile",
          "--windows-hide-console",
          "--outfile",
          compiled,
          source,
        ],
        {
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const compileOutput = new Response(compiler.stdout).text();
      const compileErrors = new Response(compiler.stderr).text();
      const compileCode = await compiler.exited;
      expect(
        compileCode,
        `${await compileOutput}\n${await compileErrors}`,
      ).toBe(0);
      // Compile at an ASCII output path; exercise spaces and Unicode at launch.
      await rename(compiled, executable);
      await Bun.write(
        launcherPath,
        `
import assert from "node:assert/strict";
import { createOperations } from ${JSON.stringify(operationsModule)};
import { activeDescendants, containAppProcess } from ${JSON.stringify(jobModule)};
containAppProcess(${JSON.stringify(resolve(root, "app-data"))});
const adapter = createOperations({ dataRoot: ${JSON.stringify(root)}, capabilities: [] });
try {
  adapter.execute("opener.openFile", { path: ${JSON.stringify(executable)} }, "backend");
  const deadline = Date.now() + 15000;
  while (!(await Bun.file(${JSON.stringify(marker)}).exists())) {
    assert(Date.now() < deadline, "Explorer did not start the helper");
    await Bun.sleep(20);
  }
  assert.equal(activeDescendants(), 0, "External launches must not inherit the app Job");
  await Bun.write(${JSON.stringify(ready)}, "ready");
  while (!(await Bun.file(${JSON.stringify(release)}).exists())) {
    assert(Date.now() < deadline, "Controller did not release the launcher");
    await Bun.sleep(20);
  }
} finally {
  adapter.dispose();
  adapter.dispose();
}
process.exit(0);
`,
      );
      launcher = Bun.spawn(
        [
          process.execPath,
          launcherPath,
        ],
        {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      if (!launcher.stdout || !launcher.stderr) {
        throw new Error("Missing launcher output pipes.");
      }
      output = new Response(launcher.stdout).text();
      errors = new Response(launcher.stderr).text();
      const deadline = Date.now() + 20000;
      while (!(await Bun.file(ready).exists())) {
        if (launcher.exitCode !== null || Date.now() > deadline) {
          launcher.kill();
          await launcher.exited;
          throw new Error(`Launcher failed: ${await output}\n${await errors}`);
        }
        await Bun.sleep(20);
      }
      const helper = (await Bun.file(marker).json()) as {
        pid: number;
      };
      handle = kernel.symbols.OpenProcess(
        PROCESS_TERMINATE | SYNCHRONIZE,
        0,
        helper.pid,
      );
      expect(handle).not.toBe(0n);
      expect(kernel.symbols.WaitForSingleObject(handle, 0)).toBe(WAIT_TIMEOUT);
      await Bun.write(release, "exit");
      expect(await launcher.exited, `${await output}\n${await errors}`).toBe(0);
      // Wait on the actual process handle after the app's last Job handle closes.
      expect(kernel.symbols.WaitForSingleObject(handle, 500)).toBe(
        WAIT_TIMEOUT,
      );
      await Bun.write(stop, "stop");
      expect(kernel.symbols.WaitForSingleObject(handle, 5000)).toBe(
        WAIT_OBJECT_0,
      );
    } finally {
      launcher?.kill();
      await launcher?.exited;
      if (!handle && (await Bun.file(marker).exists())) {
        const helper = (await Bun.file(marker).json()) as {
          pid: number;
        };
        handle = kernel.symbols.OpenProcess(
          PROCESS_TERMINATE | SYNCHRONIZE,
          0,
          helper.pid,
        );
      }
      if (handle) {
        if (kernel.symbols.WaitForSingleObject(handle, 0) !== WAIT_OBJECT_0) {
          kernel.symbols.TerminateProcess(handle, 1);
          kernel.symbols.WaitForSingleObject(handle, 5000);
        }
        kernel.symbols.CloseHandle(handle);
      }
      await Bun.write(stop, "stop");
      kernel.close();
      await rm(root, {
        recursive: true,
        force: true,
      });
    }
  },
  60000,
);
