import { dlopen, JSCallback, ptr } from "bun:ffi";
import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { bundleWindowsHost } from "../../packages/cli/src/assets.ts";
import { writeJson } from "../../packages/cli/src/files.ts";
import { compileWindowsApp } from "../../packages/cli/src/launch.ts";

test.skipIf(process.platform !== "win32")(
  "Compiled app embeds assets and icons, preserves argv, disables cwd config and reports startup failures",
  async () => {
    const root = await mkdtemp(resolve(tmpdir(), "bunaway-gui-test-"));
    const appId = `app.launcher-test-${crypto.randomUUID()}`;
    const title = 'GUI 테스트 "앱"';
    if (!process.env.LOCALAPPDATA) {
      throw new Error("Expected LOCALAPPDATA.");
    }
    const log = resolve(
      process.env.LOCALAPPDATA,
      "bunaway",
      appId,
      "logs/startup-error.log",
    );
    const user = dlopen("user32.dll", {
      GetClassLongPtrW: {
        args: [
          "u64",
          "i32",
        ],
        returns: "u64",
      },
      EnumWindows: {
        args: [
          "ptr",
          "i64",
        ],
        returns: "i32",
      },
      GetWindowThreadProcessId: {
        args: [
          "u64",
          "ptr",
        ],
        returns: "u32",
      },
      GetWindowTextW: {
        args: [
          "u64",
          "ptr",
          "i32",
        ],
        returns: "i32",
      },
      GetClassNameW: {
        args: [
          "u64",
          "ptr",
          "i32",
        ],
        returns: "i32",
      },
      PostMessageW: {
        args: [
          "u64",
          "u32",
          "u64",
          "i64",
        ],
        returns: "i32",
      },
    });
    async function watchDialog(
      child: Bun.Subprocess<"ignore", "pipe", "pipe">,
      caption: string,
    ) {
      let dialog = false;
      let consoleSeen = false;
      const callback = new JSCallback(
        (hwnd: bigint) => {
          const owner = new Uint32Array(1);
          user.symbols.GetWindowThreadProcessId(hwnd, ptr(owner));
          if (owner[0] !== child.pid) {
            return 1;
          }
          const text = Buffer.alloc(512);
          const count = user.symbols.GetWindowTextW(hwnd, ptr(text), 256);
          if (text.subarray(0, count * 2).toString("utf16le") === caption) {
            dialog = true;
            user.symbols.PostMessageW(hwnd, 0x10, 0n, 0n);
          }
          const kind = Buffer.alloc(512);
          const length = user.symbols.GetClassNameW(hwnd, ptr(kind), 256);
          consoleSeen ||=
            kind.subarray(0, length * 2).toString("utf16le") ===
            "ConsoleWindowClass";
          return 1;
        },
        {
          args: [
            "u64",
            "i64",
          ],
          returns: "i32",
        },
      );
      const timer = setTimeout(() => child.kill(), 15000);
      try {
        while (child.exitCode === null) {
          user.symbols.EnumWindows(callback.ptr, 0n);
          await Bun.sleep(20);
        }
        return {
          exitCode: await child.exited,
          stderr: await new Response(child.stderr).text(),
          dialog,
          consoleSeen,
        };
      } finally {
        clearTimeout(timer);
        if (child.exitCode === null) {
          child.kill();
        }
        await child.exited;
        callback.close();
      }
    }
    try {
      await mkdir(resolve(root, "assets"));
      await mkdir(resolve(root, "assets/web"));
      // A real 16x16 ICO with a 32-bit DIB and transparency mask.
      const ico = Buffer.alloc(22 + 40 + 16 * 16 * 4 + 16 * 4);
      ico.writeUInt16LE(1, 2);
      ico.writeUInt16LE(1, 4);
      ico[6] = 16;
      ico[7] = 16;
      ico.writeUInt16LE(1, 10);
      ico.writeUInt16LE(32, 12);
      ico.writeUInt32LE(ico.length - 22, 14);
      ico.writeUInt32LE(22, 18);
      ico.writeUInt32LE(40, 22);
      ico.writeInt32LE(16, 26);
      ico.writeInt32LE(32, 30);
      ico.writeUInt16LE(1, 34);
      ico.writeUInt16LE(32, 36);
      ico.fill(255, 62, 62 + 16 * 16 * 4);
      await writeFile(resolve(root, "app.ico"), ico);
      const { Windows } = await import("../../native/windows/bun/win32.ts");
      const windows = new Windows(() => {}, resolve(root, "app.ico"));
      const hwnd = windows.create(title, 200, 200, () => {}, false);
      try {
        expect(user.symbols.GetClassLongPtrW(hwnd, -14)).toBe(windows.icon);
        expect(user.symbols.GetClassLongPtrW(hwnd, -34)).not.toBe(0n);
      } finally {
        windows.destroy(hwnd);
        windows.dispose();
      }
      const executable = resolve(root, "내 앱.exe");
      await cp(resolve(root, "app.ico"), resolve(root, "assets/app.ico"));
      const source = resolve(root, "app.ts");
      const win32 = resolve(
        import.meta.dir,
        "../../native/windows/bun/win32.ts",
      );
      await writeFile(
        source,
        `import { dlopen } from "bun:ffi";
import { Windows } from ${JSON.stringify(win32)};
const argv = process.argv.slice(2);
if (argv[0] === "fail") throw new Error("startup-test-failed");
const kernel = dlopen("kernel32.dll", { GetConsoleWindow: { args: [], returns: "u64" } });
const windows = new Windows(() => {}, process.execPath);
const hwnd = windows.create("test", 200, 200, () => {}, false);
const result = {
  argv, cwd: process.cwd(), console: kernel.symbols.GetConsoleWindow().toString(),
  icon: windows.icon !== 0n,
  asset: await Bun.file(new URL("./web/한글 😀.txt", import.meta.url)).text(),
  polluted: process.env.CWD_POLLUTION ?? null,
};
windows.destroy(hwnd); windows.dispose(); kernel.close();
await Bun.write(new URL("./launch.json", Bun.pathToFileURL(process.execPath)), JSON.stringify(result));
if (argv[0] === "hold") { console.log("owned"); await Bun.stdin.text(); }
process.exit(0);
export default { commands: {}, events: {} };
`,
      );
      await writeJson(resolve(root, "assets/app.json"), {
        appId,
        title,
        icon: "app.ico",
        view: "main",
        home: "https://app.bunaway.local/index.html",
        window: {
          width: 200,
          height: 200,
        },
      });
      await cp(
        resolve(import.meta.dir, "../fixtures/desktop/host/policy.json"),
        resolve(root, "assets/policy.json"),
      );
      await writeFile(
        resolve(root, "assets/web/index.html"),
        "<h1>embedded</h1>",
      );
      await writeFile(resolve(root, "assets/web/한글 😀.txt"), "embedded text");
      await bundleWindowsHost(
        resolve(import.meta.dir, "../../native/windows/bun"),
        resolve(root, "assets"),
        source,
      );
      await compileWindowsApp(
        root,
        process.execPath,
        "내 앱.exe",
        {
          title,
          icon: "app.ico",
        },
        new AbortController().signal,
      );
      expect(await Bun.file(resolve(root, "assets/app.json")).exists()).toBe(
        false,
      );
      const pe = await readFile(executable);
      expect(pe.readUInt16LE(pe.readUInt32LE(0x3c) + 24 + 68)).toBe(2);
      await writeFile(resolve(root, ".env"), "CWD_POLLUTION=yes");
      await writeFile(resolve(root, "bunfig.toml"), 'preload = ["./bad.ts"]');
      await writeFile(
        resolve(root, "bad.ts"),
        'throw new Error("cwd preload");',
      );
      for (const argv of [
        [],
        [
          "--",
          "-Wait",
          'a"b',
          "C:\\tail\\",
          "",
          "한글 😀.txt",
        ],
        [
          "fail",
        ],
      ]) {
        const child = Bun.spawn(
          [
            executable,
            ...argv,
          ],
          {
            cwd: root,
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        const failed = argv[0] === "fail";
        const observed = await watchDialog(child, title);
        expect(observed.exitCode, observed.stderr).toBe(failed ? 1 : 0);
        expect(observed.dialog).toBe(failed);
        expect(observed.consoleSeen).toBe(false);
        if (failed) {
          expect(await Bun.file(log).text()).toContain("startup-test-failed");
        } else {
          expect(await Bun.file(resolve(root, "launch.json")).json()).toEqual({
            argv,
            cwd: root,
            console: "0",
            icon: true,
            asset: "embedded text",
            polluted: null,
          });
        }
      }
      const failureRoot = resolve(root, "known-folder-failure");
      const failureAssets = resolve(failureRoot, "assets");
      const failureAppId = `known-folder-failure-${crypto.randomUUID()}`;
      const failureApp = resolve(failureRoot, "app.ts");
      await mkdir(resolve(failureAssets, "web"), {
        recursive: true,
      });
      await writeJson(resolve(failureAssets, "app.json"), {
        appId: failureAppId,
        title: "Known Folder failure",
        view: "main",
        home: "https://app.bunaway.local/index.html",
        window: {
          width: 200,
          height: 200,
        },
      });
      await cp(
        resolve(import.meta.dir, "../fixtures/desktop/host/policy.json"),
        resolve(failureAssets, "policy.json"),
      );
      await writeFile(
        resolve(failureAssets, "web/index.html"),
        "<h1>embedded</h1>",
      );
      await writeFile(
        failureApp,
        "export default { commands: {}, events: {} };\n",
      );
      await bundleWindowsHost(
        resolve(import.meta.dir, "../../native/windows/bun"),
        failureAssets,
        failureApp,
      );
      const failureBootPath = resolve(failureAssets, "boot.js");
      const boot = await readFile(failureBootPath, "utf8");
      expect(boot.match(/function localAppData\(\) \{/g)).toHaveLength(1);
      const failureBoot = boot.replace(
        /function localAppData\(\) \{[\s\S]*?\n\}/,
        'function localAppData() { throw new Error("known-folder-failure-injected"); }',
      );
      expect(failureBoot).not.toBe(boot);
      await writeFile(failureBootPath, failureBoot);
      const failureExecutable = resolve(failureRoot, `${failureAppId}.exe`);
      await compileWindowsApp(
        failureRoot,
        process.execPath,
        `${failureAppId}.exe`,
        {
          title: "Bunaway",
        },
        new AbortController().signal,
      );
      const failureChild = Bun.spawn(
        [
          failureExecutable,
        ],
        {
          cwd: root,
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const failure = await watchDialog(failureChild, "Bunaway");
      expect(failure.exitCode, failure.stderr).toBe(1);
      expect(failure.stderr).toContain("known-folder-failure-injected");
      expect(failure.dialog).toBe(true);
      expect(failure.consoleSeen).toBe(false);
      expect(
        await Bun.file(
          resolve(
            process.env.LOCALAPPDATA ?? "",
            "bunaway",
            failureAppId,
            "logs/startup-error.log",
          ),
        ).exists(),
      ).toBe(false);
      const owner = Bun.spawn(
        [
          executable,
          "hold",
        ],
        {
          cwd: root,
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      let duplicate: ReturnType<typeof Bun.spawn> | undefined;
      const deadline = setTimeout(() => {
        owner.kill();
        duplicate?.kill();
      }, 15000);
      try {
        const reader = owner.stdout.getReader();
        expect(new TextDecoder().decode((await reader.read()).value)).toContain(
          "owned",
        );
        reader.releaseLock();
        // A duplicate must forward its arguments without importing the app's failing entrypoint.
        duplicate = Bun.spawn(
          [
            executable,
            "fail",
          ],
          {
            cwd: root,
            stderr: "pipe",
          },
        );
        expect(await duplicate.exited).toBe(0);
        expect(owner.exitCode).toBeNull();
        owner.stdin.end();
        expect(await owner.exited).toBe(0);
      } finally {
        clearTimeout(deadline);
        if (duplicate?.exitCode === null) {
          duplicate.kill();
        }
        if (owner.exitCode === null) {
          owner.kill();
        }
        await owner.exited;
        if (duplicate) {
          await duplicate.exited;
        }
      }
    } finally {
      user.close();
      await rm(root, {
        recursive: true,
        force: true,
      });
      await rm(resolve(log, "../.."), {
        recursive: true,
        force: true,
      });
    }
  },
  90000,
);
