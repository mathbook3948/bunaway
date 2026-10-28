// Registered by windows.test.ts so the Windows installer job, which runs the real Inno Setup
// installer, executes it. The Check job skips windows.test.ts on Windows.
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StageContext } from "@bunaway/packaging";
import { findIscc, must } from "#packaging/channels/windows/common";
import {
  compileInno,
  renderInnoScript,
} from "#packaging/channels/windows/inno";
import { innoIdentity } from "#packaging/channels/windows/inno-identity";

const iscc = process.platform === "win32" ? await findIscc() : undefined;

const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
const powershell = join(
  systemRoot,
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);
const psLiteral = (value: string) => `'${value.replaceAll("'", "''")}'`;

/** Reads a .lnk through WScript.Shell, the same COM object Explorer scripts use. */
async function readLink(path: string) {
  const output = await must(powershell, [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `[Console]::OutputEncoding=[Text.Encoding]::UTF8; $link=(New-Object -ComObject WScript.Shell).CreateShortcut(${psLiteral(path)}); [Console]::WriteLine((ConvertTo-Json -InputObject @{Target=$link.TargetPath;WorkingDirectory=$link.WorkingDirectory} -Compress))`,
  ]);
  return JSON.parse(output.stdout.trim()) as {
    Target: string;
    WorkingDirectory: string;
  };
}

/** The app writes what the process sees to the file named by its first argument, then exits. */
const appSource = `import { writeFileSync } from "node:fs";
writeFileSync(
  process.argv[2] as string,
  JSON.stringify({ execPath: process.execPath, cwd: process.cwd() }),
);
`;

interface Observed {
  execPath: string;
  cwd: string;
}

test.skipIf(!iscc)(
  "an app installed into a folder with spaces and Korean launches, and uninstalling leaves nothing behind",
  async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "bunaway-installed-launch-")),
    );
    const identifier = `app.test-${crypto.randomUUID()}`;
    const executableName = "시험 앱 launch.exe";
    const name = "설치 시험 앱";
    // The folder shape a user picks in the installer: a space, Korean and a nested level.
    const install = join(root, "Test Dir 한글", "설치 폴더 2");
    const menu = join(root, "시작 메뉴 폴더");
    const uninstall = join(install, "unins000.exe");
    const staging = join(root, "staging");
    const silent = [
      "/VERYSILENT",
      "/SUPPRESSMSGBOXES",
      "/NORESTART",
    ];
    const registryKey = `HKCU\\${innoIdentity(identifier).previousDataKey}`;
    const registered = async () =>
      (await Bun.spawn(
        [
          join(systemRoot, "System32", "reg.exe"),
          "query",
          registryKey,
        ],
        {
          stdout: "ignore",
          stderr: "ignore",
        },
      ).exited) === 0;
    async function removeInstallation() {
      await must(uninstall, silent);
      // Inno's launcher exits before its temporary copy finishes uninstalling.
      for (let retry = 0; retry < 200; retry++) {
        if (!(await Bun.file(uninstall).exists())) {
          return;
        }
        await Bun.sleep(50);
      }
      throw new Error("The uninstaller did not finish.");
    }
    async function launch(executable: string, cwd: string, marker: string) {
      const proc = Bun.spawn(
        [
          executable,
          marker,
        ],
        {
          cwd,
          stdout: "ignore",
          stderr: "ignore",
        },
      );
      expect(await proc.exited).toBe(0);
      return JSON.parse(await readFile(marker, "utf8")) as Observed;
    }
    try {
      await mkdir(join(staging, "app"), {
        recursive: true,
      });
      await mkdir(join(staging, "installer"));
      await mkdir(menu);
      const source = join(staging, "app-source.ts");
      await Bun.write(source, appSource);
      const built = Bun.spawnSync([
        process.execPath,
        "build",
        "--compile",
        source,
        "--outfile",
        join(staging, "app", executableName),
      ]);
      expect(built.exitCode).toBe(0);
      const script = renderInnoScript({
        name,
        identifier,
        executableName,
        version: "1.0.0",
        publisher: "Test",
        scope: "perUser",
        payloadDir: join(staging, "app"),
        outputDir: join(staging, "installer"),
        outputBaseName: "setup",
        desktopShortcut: false,
        startMenuShortcut: true,
        webView2: "check",
        appDataDir: join(root, "data"),
        preserveUserData: true,
        assetPaths: [],
      })
        // Keep the shortcuts inside the test folder, not in the runner's Start menu.
        .replaceAll("{group}", menu)
        .replace("CloseApplications=yes", "CloseApplications=no");
      const ctx = {
        input: {},
        staging,
        report() {},
        addArtifact() {},
      } as unknown as StageContext;
      const setup = await compileInno(ctx, script, staging, "setup");
      await must(setup, [
        "/SP-",
        ...silent,
        `/LOG=${join(staging, "setup.log")}`,
        `/DIR=${install}`,
      ]);
      const installed = join(install, executableName);
      expect(await Bun.file(installed).exists()).toBe(true);
      expect(await registered()).toBe(true);

      // The Start menu entry points at the installed executable and its folder.
      const link = await readLink(join(menu, `${name}.lnk`));
      expect(link.Target.toLowerCase()).toBe(installed.toLowerCase());
      expect(link.WorkingDirectory.toLowerCase()).toBe(install.toLowerCase());

      // Start it the way the shortcut does: its target, in its working directory.
      const fromShortcut = await launch(
        link.Target,
        link.WorkingDirectory,
        join(root, "표식 shortcut.json"),
      );
      expect(fromShortcut.execPath.toLowerCase()).toBe(installed.toLowerCase());
      expect(fromShortcut.cwd.toLowerCase()).toBe(install.toLowerCase());

      // Start it from an unrelated folder, as a protocol or file association launch would.
      const fromElsewhere = await launch(
        installed,
        root,
        join(root, "표식 elsewhere.json"),
      );
      expect(fromElsewhere.execPath.toLowerCase()).toBe(
        installed.toLowerCase(),
      );
      expect(fromElsewhere.cwd.toLowerCase()).toBe(root.toLowerCase());

      await removeInstallation();
      expect(await Bun.file(installed).exists()).toBe(false);
      expect(await Bun.file(join(menu, `${name}.lnk`)).exists()).toBe(false);
      expect(await Bun.file(join(menu, `${name} 제거.lnk`)).exists()).toBe(
        false,
      );
      expect(await registered()).toBe(false);
      // Inno removes the folder it created, not the parent the test made.
      expect(await stat(install).catch(() => undefined)).toBeUndefined();
    } finally {
      if (await Bun.file(uninstall).exists()) {
        await removeInstallation().catch(() => {});
      }
      await rm(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    }
  },
  180000,
);
