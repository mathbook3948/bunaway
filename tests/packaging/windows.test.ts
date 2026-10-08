import { expect, spyOn, test } from "bun:test";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as windowsTools from "../../packages/packaging/src/channels/windows/common.ts";
import {
  copyPayload,
  findIscc,
  findWindowsKitTool,
  must,
} from "../../packages/packaging/src/channels/windows/common.ts";
import {
  compileInno,
  prepareInnoSigning,
  renderInnoScript,
} from "../../packages/packaging/src/channels/windows/inno.ts";
import { renderAppxManifest } from "../../packages/packaging/src/channels/windows/msix.ts";
import { signingArgs } from "../../packages/packaging/src/channels/windows/sign.ts";
import {
  type AdapterInput,
  type AdapterStage,
  adapterFor,
  parsePackaging,
  type ResolvedPackaging,
  registeredChannels,
  type SigningConfig,
  type StageContext,
} from "../../packages/packaging/src/index.ts";

const metadata: ResolvedPackaging = {
  root: "C:\\proj",
  name: "Test App",
  identifier: "com.example.app",
  publisher: {
    display: "Example",
    identity: "CN=Example",
  },
  version: {
    semver: "1.2.3",
    build: 0,
    msix: "1.2.3.0",
  },
  icons: {},
  targets: [
    {
      platform: "windows",
      arch: "x64",
    },
  ],
};

const input = (
  channelConfig: Record<string, unknown>,
  signing?: SigningConfig,
): AdapterInput => ({
  channel: "win-direct",
  channelConfig,
  metadata,
  target: "windows-x64",
  artifact: {
    dir: "C:\\proj\\dist\\windows-x64",
    packageDir: "C:\\proj\\dist\\windows-x64",
    executable: "C:\\proj\\dist\\windows-x64\\com.example.app.exe",
  },
  manifest: {
    bun: {
      version: "1.4.2",
      sourceRevision: "744846f844374847c902b5e7fd59b4342a51ef99",
      target: "windows-x64-baseline",
      executableSha256: "aa",
      licenseSha256: "bb",
    },
    assets: {},
    app: {
      id: "com.example.app",
      version: "1.2.3",
    },
    host: {
      target: "windows-x64",
      kind: "bun-compiled",
      executable: "com.example.app.exe",
      sha256: "cc",
    },
  },
  ...(signing
    ? {
        signing,
      }
    : {}),
});

const runIds = (stages: AdapterStage[]) => stages.map((stage) => stage.id);

const adapterOrThrow = (channel: string) => {
  const adapter = adapterFor(channel as never);
  if (!adapter) {
    throw new Error(`${channel} adapter missing`);
  }
  return adapter;
};

const iscc = process.platform === "win32" ? await findIscc() : undefined;

test.skipIf(!iscc)(
  "Inno refuses failed prerequisites before replacing an installed app",
  async () => {
    if (!iscc) {
      throw new Error("Expected ISCC.");
    }
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "bunaway-inno-prerequisites-")),
    );
    const literal = (path: string) => path.replace(/'/g, "''");
    try {
      for (const outcome of [
        "launch-error",
        "exit-error",
        "undetected",
        "installed",
        "existing",
        "old-os",
      ]) {
        const staging = join(root, outcome);
        const install = join(staging, "installed");
        const marker = join(staging, "runtime-present");
        const trace = join(staging, "bootstrap-ran");
        const host = join(install, "com.example.app.exe");
        await Bun.write(host, "previous app");
        await Bun.write(join(staging, "app", "com.example.app.exe"), "new app");
        await mkdir(join(staging, "installer"));
        const bootstrapper = join(staging, "installer", "bootstrapper.exe");
        if (outcome === "launch-error") {
          await Bun.write(bootstrapper, "not an executable");
        } else {
          const script = join(staging, "bootstrapper.iss");
          await Bun.write(
            script,
            `[Setup]
AppName=Prerequisite fixture
AppVersion=1.0
DefaultDirName=${join(staging, "unused")}
OutputDir=${join(staging, "installer")}
OutputBaseFilename=bootstrapper
PrivilegesRequired=lowest
CreateAppDir=no
Uninstallable=no
DisableStartupPrompt=yes
[Code]
function InitializeSetup: Boolean;
begin
  SaveStringToFile('${literal(trace)}', 'started', False);
  ${outcome === "installed" ? `SaveStringToFile('${literal(marker)}', 'runtime', False);` : ""}
  Result := True;
end;
function GetCustomSetupExitCode: Integer;
begin
  Result := ${outcome === "exit-error" ? 42 : 0};
end;
`,
          );
          await must(iscc, [
            "/Q",
            script,
          ]);
        }
        if (outcome === "existing") {
          await Bun.write(marker, "runtime");
        }
        let script = renderInnoScript({
          name: "Prerequisite fixture",
          identifier: `app.test-${crypto.randomUUID()}`,
          version: "1.0.0",
          publisher: "Test",
          scope: "perUser",
          payloadDir: join(staging, "app"),
          outputDir: join(staging, "installer"),
          outputBaseName: "setup",
          desktopShortcut: false,
          startMenuShortcut: false,
          webView2: "bootstrap",
          bootstrapperPath: bootstrapper,
          appDataDir: join(staging, "data"),
          preserveUserData: true,
          assetPaths: [],
          minVersion: outcome === "old-os" ? "10.0.65535.0" : "10.0.17763.0",
        })
          .replace("UninstallLogMode=overwrite", "Uninstallable=no")
          // Dummy executables do not need Restart Manager's machine-wide scan.
          .replace("CloseApplications=yes", "CloseApplications=no");
        // Probe a fixture marker, without changing the machine's WebView2 registry.
        script = script.replace(
          /function HasWebView2Runtime: Boolean;[\s\S]*?\nend;\n/,
          `function HasWebView2Runtime: Boolean;\nbegin\n  Result := FileExists('${literal(marker)}');\nend;\n`,
        );
        const ctx: StageContext = {
          input: input({}),
          staging,
          report() {},
          addArtifact() {},
        };
        const setup = await compileInno(ctx, script, staging, "setup");
        const proc = Bun.spawn(
          [
            setup,
            "/SP-",
            "/VERYSILENT",
            "/SUPPRESSMSGBOXES",
            "/NORESTART",
            `/LOG=${join(staging, "setup.log")}`,
            `/DIR=${install}`,
          ],
          {
            stdout: "ignore",
            stderr: "ignore",
          },
        );
        const success = outcome === "installed" || outcome === "existing";
        const exit = await proc.exited;
        expect(exit).toBe(success ? 0 : outcome === "old-os" ? 1 : 7);
        expect(await Bun.file(host).exists()).toBe(true);
        if (!success) {
          expect(await Bun.file(host).text()).toBe("previous app");
        } else {
          expect(
            await Bun.file(join(install, "com.example.app.exe")).text(),
          ).toBe("new app");
        }
        expect(await Bun.file(trace).exists()).toBe(
          ![
            "launch-error",
            "existing",
            "old-os",
          ].includes(outcome),
        );
      }
    } finally {
      await rm(root, {
        recursive: true,
        force: true,
      });
    }
  },
  120000,
);

test.each([
  "win-direct",
  "win-store-unpackaged",
] as const)(
  "%s forwards the matching target minimum Windows version to Inno",
  async (channel) => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "bunaway-inno-minimum-")),
    );
    const discovery = spyOn(windowsTools, "findIscc").mockResolvedValue(
      "fixture-iscc",
    );
    const compiler = spyOn(windowsTools, "must").mockResolvedValue({
      code: 0,
      stdout: "",
      stderr: "",
    });
    try {
      const source = join(root, "source");
      await Bun.write(join(source, "com.example.app.exe"), "fixture");
      const original = input({
        webView2: "check",
      });
      const config = parsePackaging(
        JSON.stringify({
          targets: [
            {
              platform: "macos",
              arch: "arm64",
              minVersion: "14.0",
            },
            {
              platform: "windows",
              arch: "x64",
              minVersion: "10.0.22621.0",
            },
          ],
          channels: {
            [channel]: {
              webView2: "check",
            },
          },
        }),
      );
      const { resolvePackaging } = await import(
        "../../packages/packaging/src/index.ts"
      );
      const resolved = await resolvePackaging({
        root,
        config,
        appId: "app.test",
        title: "Test",
        projectVersion: "1.0.0",
        channel,
      });
      const adapterInput: AdapterInput = {
        ...original,
        channel,
        metadata: resolved.metadata,
        channelConfig: resolved.channel.channelConfig,
        artifact: {
          dir: source,
          packageDir: source,
          executable: join(source, "com.example.app.exe"),
        },
      };
      const stages = adapterOrThrow(channel).stages(adapterInput);
      const ctx: StageContext = {
        input: adapterInput,
        staging: join(root, "stage"),
        report() {},
        addArtifact() {},
      };
      await stages.find((stage) => stage.id === "stage")?.run(ctx);
      await stages.find((stage) => stage.id === "assemble")?.run(ctx);
      expect(
        await Bun.file(join(ctx.staging, "app.test-setup-1.0.0.iss")).text(),
      ).toContain("MinVersion=10.0.22621\n");
    } finally {
      discovery.mockRestore();
      compiler.mockRestore();
      await rm(root, {
        recursive: true,
        force: true,
      });
    }
  },
);

test.skipIf(!iscc)(
  "Inno compiles literal display names and the WebView2 version check",
  async () => {
    const root = join(
      await realpath(await mkdtemp(join(tmpdir(), "bunaway-inno-compile-"))),
      "{demo}",
    );
    try {
      await Bun.write(
        join(root, "app", "com.example.app.exe"),
        "runtime fixture",
      );
      await Bun.write(join(root, "bootstrapper.exe"), "bootstrapper fixture");
      await mkdir(join(root, "installer"));
      const ctx: StageContext = {
        input: input({}),
        staging: root,
        report() {},
        addArtifact() {},
      };
      const script = renderInnoScript({
        name: 'My "App" {Beta}',
        identifier: metadata.identifier,
        version: metadata.version.semver,
        publisher: 'Example {Company} "Ltd"',
        scope: "perUser",
        payloadDir: join(root, "app"),
        outputDir: join(root, "installer"),
        outputBaseName: "setup",
        desktopShortcut: true,
        startMenuShortcut: true,
        webView2: "bootstrap",
        bootstrapperPath: join(root, "bootstrapper.exe"),
        appDataDir: "{localappdata}\\bunaway\\test.app",
        preserveUserData: true,
        assetPaths: [],
      });
      const installer = await compileInno(ctx, script, root, "setup");
      expect(await Bun.file(installer).exists()).toBe(true);
      expect(Bun.file(installer).size).toBeGreaterThan(0);
    } finally {
      await rm(resolve(root, ".."), {
        recursive: true,
        force: true,
      });
    }
  },
  30000,
);

test.skipIf(!iscc)(
  "Inno upgrades apply current uninstall policy and prune licenses without following junctions",
  async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "bunaway-inno-upgrade-")),
    );
    const install = join(root, "install");
    const data = join(root, "data", "memo.txt");
    const uninstall = join(install, "unins000.exe");
    const identifier = `app.test-${crypto.randomUUID()}`;
    const silent = [
      "/VERYSILENT",
      "/SUPPRESSMSGBOXES",
      "/NORESTART",
    ];
    async function removeInstallation() {
      await must(uninstall, silent);
      // Inno's launcher exits before its temporary copy finishes uninstalling.
      for (let retry = 0; retry < 100; retry++) {
        if (!(await Bun.file(uninstall).exists())) {
          return;
        }
        await Bun.sleep(50);
      }
      throw new Error("The fixture uninstaller did not finish.");
    }
    try {
      for (const version of [
        1,
        2,
        3,
      ]) {
        const staging = join(root, String(version));
        const payloadDir = join(staging, "app");
        const assetPaths = [
          "licenses/case.js",
          "licenses/quote's.js",
          "licenses/current.txt",
        ];
        if (version === 1) {
          assetPaths.push("licenses/retired/page.html", "licenses/retired.txt");
        }
        await Bun.write(
          join(payloadDir, `${identifier}.exe`),
          `app ${version}`,
        );
        for (const path of assetPaths) {
          await Bun.write(join(payloadDir, path), String(version));
        }
        await mkdir(join(staging, "installer"));
        const ctx: StageContext = {
          input: input({}),
          staging,
          report() {},
          addArtifact() {},
        };
        const script = renderInnoScript({
          name: "Bunaway test fixture",
          identifier,
          version: `${version}.0.0`,
          publisher: "Test",
          scope: "perUser",
          payloadDir,
          outputDir: join(staging, "installer"),
          outputBaseName: "setup",
          desktopShortcut: false,
          startMenuShortcut: false,
          webView2: "check",
          appDataDir: join(root, "data"),
          preserveUserData: version === 2,
          assetPaths,
        });
        const setup = await compileInno(ctx, script, staging, "setup");
        await must(setup, [
          "/SP-",
          ...silent,
          `/DIR=${install}`,
        ]);
        if (version === 1) {
          await Bun.write(data, "memo");
          await Bun.write(join(root, "external", "keep.txt"), "external data");
          await symlink(
            join(root, "external"),
            join(install, "licenses", "external"),
            "junction",
          );
          continue;
        }
        expect(
          await Bun.file(join(install, "licenses/retired/page.html")).exists(),
        ).toBe(false);
        expect(
          await Bun.file(join(install, "licenses/retired.txt")).exists(),
        ).toBe(false);
        expect(await Bun.file(join(install, "licenses/case.js")).text()).toBe(
          String(version),
        );
        expect(await Bun.file(join(install, `${identifier}.exe`)).text()).toBe(
          `app ${version}`,
        );
        expect(
          await Bun.file(join(install, "licenses/quote's.js")).text(),
        ).toBe(String(version));
        expect(await Bun.file(data).text()).toBe("memo");
        expect(await Bun.file(join(root, "external", "keep.txt")).text()).toBe(
          "external data",
        );
        if (version === 2) {
          await rm(join(install, "licenses", "external"));
        }
        await removeInstallation();
        expect(await Bun.file(data).exists()).toBe(version === 2);
      }
    } finally {
      if (await Bun.file(uninstall).exists()) {
        await removeInstallation();
      }
      await rm(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    }
  },
  60000,
);

test.skipIf(!iscc)(
  "Inno upgrades preserve shortcut names, locations and arguments, then uninstall managed links",
  async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "bunaway-inno-shortcuts-")),
    );
    const install = join(root, "install");
    const menu = join(root, "menu");
    const desktop = join(root, "desktop");
    const data = join(root, "data", "memo.txt");
    const uninstall = join(install, "unins000.exe");
    const identifier = `app.test-${crypto.randomUUID()}`;
    const names = [
      "Old's 🚀 {App}",
      "New's 🚀 {App}",
      "New's 🚀 {App}",
      "New's 🚀 {App}",
    ];
    const executableNames = [
      "old's {앱🧪}.exe",
      "new's {앱🧪}.exe",
      "new's {앱🧪}.exe",
      "new's {앱🧪}.exe",
    ];
    const silent = [
      "/VERYSILENT",
      "/SUPPRESSMSGBOXES",
      "/NORESTART",
    ];
    const unrelated = [
      join(menu, "Unrelated.lnk"),
      join(menu, "Other install.lnk"),
      join(desktop, `Other (${identifier}).lnk`),
    ];
    const renamedDesktop = join(desktop, "사용자 바로가기 🚀.lnk");
    const retargeted = join(menu, "Retargeted.lnk");
    let unchangedLink = Buffer.alloc(0);
    const powershell = join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    const psLiteral = (value: string) => `'${value.replaceAll("'", "''")}'`;
    async function readShortcut(path: string) {
      const output = await must(powershell, [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$folder=(New-Object -ComObject Shell.Application).Namespace(${psLiteral(join(path, ".."))}); $link=$folder.ParseName(${psLiteral(path.split(/[\\/]/).pop() as string)}).GetLink(); [Console]::WriteLine((ConvertTo-Json -InputObject @{Target=$link.Path;Arguments=$link.Arguments;WorkingDirectory=$link.WorkingDirectory} -Compress))`,
      ]);
      return JSON.parse(output.stdout.trim()) as {
        Target: string;
        Arguments: string;
        WorkingDirectory: string;
      };
    }
    async function removeInstallation() {
      await must(uninstall, silent);
      for (let retry = 0; retry < 100; retry++) {
        if (!(await Bun.file(uninstall).exists())) {
          return;
        }
        await Bun.sleep(50);
      }
      throw new Error("The fixture uninstaller did not finish.");
    }
    try {
      await Bun.write(join(root, "other.exe"), "unrelated executable");
      await Bun.write(
        join(root, "other-install", executableNames[0] as string),
        "another install",
      );
      for (let index = 0; index < names.length; index++) {
        const name = names[index] as string;
        const executableName = executableNames[index] as string;
        const staging = join(root, String(index));
        await Bun.write(
          join(staging, "app", executableName),
          `GUI fixture ${index + 1}`,
        );
        await mkdir(join(staging, "installer"));
        const ctx: StageContext = {
          input: input({}),
          staging,
          report() {},
          addArtifact() {},
        };
        let script = renderInnoScript({
          name,
          identifier,
          executableName,
          version: `${index + 1}.0.0`,
          publisher: "Test",
          scope: "perUser",
          payloadDir: join(staging, "app"),
          outputDir: join(staging, "installer"),
          outputBaseName: "setup",
          desktopShortcut: index < 3,
          startMenuShortcut: index < 3,
          webView2: "check",
          appDataDir: join(root, "data"),
          preserveUserData: true,
          assetPaths: [],
        })
          .replaceAll("{group}", menu)
          .replaceAll("{autodesktop}", desktop);
        if (index === 0) {
          script = script.replace(
            "[Run]\n",
            `Name: "${menu}\\User profile"; Filename: "{app}\\${executableName.replaceAll("{", "{{")}"; Parameters: "--profile custom"; Flags: uninsneveruninstall\n[Run]\n`,
          );
        }
        if (index === 2) {
          script = script.replace(
            "[Run]\n",
            `Name: "${menu}\\Retargeted"; Filename: "{app}\\${executableName.replaceAll("{", "{{")}"; Flags: uninsneveruninstall; AfterInstall: RememberShortcut('${retargeted.replaceAll("'", "''")}')\n[Run]\n`,
          );
        }
        if (index === 0) {
          script = script.replace(
            "[Run]\n",
            `Name: "${menu}\\Unrelated"; Filename: "${root}\\other.exe"\nName: "${menu}\\Other install"; Filename: "${root}\\other-install\\${executableNames[0]?.replaceAll("{", "{{")}"; Parameters: "--other"\nName: "${desktop}\\Other (${identifier})"; Filename: "${root}\\other.exe"\nName: "${menu}\\PowerShell other file"; Filename: "{sys}\\WindowsPowerShell\\v1.0\\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\\other.ps1"" ""{app}\\launch.ps1"""\nName: "${menu}\\PowerShell mention"; Filename: "{sys}\\WindowsPowerShell\\v1.0\\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -Command ""Write-Output '{app}\\launch.ps1'"""\n[Run]\n`,
          );
        }
        const setup = await compileInno(ctx, script, staging, "setup");
        await must(setup, [
          "/SP-",
          ...silent,
          `/DIR=${install}`,
          `/TASKS=${index < 2 ? "desktopicon" : "!desktopicon"}`,
        ]);
        if (index === 0) {
          await Bun.write(data, "memo");
          await Bun.write(join(menu, "broken.lnk"), "not a shortcut");
          await must(powershell, [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `$folder=(New-Object -ComObject Shell.Application).Namespace(${psLiteral(menu)}); $link=$folder.ParseName(${psLiteral(`${names[0]}.lnk`)}).GetLink(); $link.Arguments='--profile "사용자 설정"'; $link.WorkingDirectory=${psLiteral(root)}; $link.Save(${psLiteral(join(menu, `${names[0]}.lnk`))})`,
          ]);
          await rename(
            join(desktop, `${names[0]} (${identifier}).lnk`),
            renamedDesktop,
          );
          // Simulate upgrading an installer that did not yet record managed links.
          await rm(join(install, ".bunaway-shortcuts.txt"));
        }
        for (const previous of new Set(names.slice(0, index + 1))) {
          const expectedShortcut = previous === names[0];
          const shortcutPath = join(menu, `${previous}.lnk`);
          const shortcutExists = await Bun.file(shortcutPath).exists();
          expect(shortcutExists, `Install ${index + 1}: ${shortcutPath}`).toBe(
            expectedShortcut,
          );
          expect(
            await Bun.file(join(menu, `${previous} 제거.lnk`)).exists(),
          ).toBe(expectedShortcut);
          expect(
            await Bun.file(
              join(desktop, `${previous} (${identifier}).lnk`),
            ).exists(),
          ).toBe(false);
        }
        for (const previous of new Set(executableNames.slice(0, index + 1))) {
          expect(await Bun.file(join(install, previous)).exists()).toBe(
            previous === executableName,
          );
        }
        expect(await Bun.file(join(install, executableName)).text()).toBe(
          `GUI fixture ${index + 1}`,
        );
        for (const link of unrelated) {
          expect(await Bun.file(link).exists()).toBe(true);
        }
        expect(await Bun.file(join(menu, "User profile.lnk")).exists()).toBe(
          true,
        );
        expect(
          await Bun.file(join(menu, "PowerShell other file.lnk")).exists(),
        ).toBe(true);
        expect(
          await Bun.file(join(menu, "PowerShell mention.lnk")).exists(),
        ).toBe(true);
        expect(await Bun.file(join(menu, "broken.lnk")).text()).toBe(
          "not a shortcut",
        );
        expect(await Bun.file(data).text()).toBe("memo");
        const links: [
          string,
          string,
        ][] = [
          [
            "User profile",
            "--profile custom",
          ],
        ];
        links.push([
          names[0] as string,
          '--profile "사용자 설정"',
        ]);
        for (const [linkName, arguments_] of links) {
          const linkPath = join(menu, `${linkName}.lnk`);
          const shortcut = await readShortcut(linkPath);
          expect(shortcut.Target.toLowerCase()).toBe(
            join(install, executableName).toLowerCase(),
          );
          expect(shortcut.Arguments).toBe(arguments_);
          if (linkName === names[0]) {
            expect(shortcut.WorkingDirectory.toLowerCase()).toBe(
              root.toLowerCase(),
            );
          }
          expect(await Bun.file(linkPath).exists()).toBe(true);
        }
        const desktopShortcut = await readShortcut(renamedDesktop);
        expect(desktopShortcut.Target.toLowerCase()).toBe(
          join(install, executableName).toLowerCase(),
        );
        expect(desktopShortcut.Arguments).toBe("");
        const otherInstall = await readShortcut(
          join(menu, "Other install.lnk"),
        );
        expect(otherInstall.Target.toLowerCase()).toBe(
          join(
            root,
            "other-install",
            executableNames[0] as string,
          ).toLowerCase(),
        );
        expect(otherInstall.Arguments).toBe("--other");
        const linkBytes = await readFile(join(menu, `${names[0]}.lnk`));
        if (index >= 2) {
          expect(linkBytes).toEqual(unchangedLink);
        }
        unchangedLink = linkBytes;
        if (index === 2) {
          await must(powershell, [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `$folder=(New-Object -ComObject Shell.Application).Namespace(${psLiteral(menu)}); $link=$folder.ParseName('Retargeted.lnk').GetLink(); $link.Path=${psLiteral(join(root, "other.exe"))}; $link.Save(${psLiteral(retargeted)})`,
          ]);
        }
      }
      await removeInstallation();
      for (const link of unrelated) {
        expect(await Bun.file(link).exists()).toBe(true);
      }
      expect(await Bun.file(join(menu, `${names[0]}.lnk`)).exists()).toBe(
        false,
      );
      expect(await Bun.file(join(menu, `${names[0]} 제거.lnk`)).exists()).toBe(
        false,
      );
      expect(await Bun.file(renamedDesktop).exists()).toBe(false);
      expect(await Bun.file(join(menu, "User profile.lnk")).exists()).toBe(
        true,
      );
      expect((await readShortcut(retargeted)).Target.toLowerCase()).toBe(
        join(root, "other.exe").toLowerCase(),
      );
      expect(await Bun.file(data).text()).toBe("memo");
    } finally {
      if (await Bun.file(uninstall).exists()) {
        await removeInstallation();
      }
      await rm(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    }
  },
  60000,
);

test.skipIf(!iscc)(
  "Inno keeps old EXEs and shortcut bytes when previous install metadata is missing or belongs elsewhere",
  async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "bunaway-inno-identity-")),
    );
    const silent = [
      "/VERYSILENT",
      "/SUPPRESSMSGBOXES",
      "/NORESTART",
    ];
    try {
      for (const mode of [
        "missing",
        "different",
      ]) {
        const fixture = join(root, mode);
        const install = join(fixture, "install");
        const menu = join(fixture, "menu");
        const identifier = `app.test-${crypto.randomUUID()}`;
        let previousLink = Buffer.alloc(0);
        for (const version of [
          1,
          2,
        ]) {
          const staging = join(fixture, String(version));
          const executableName = version === 1 ? "Old.exe" : "New.exe";
          await Bun.write(join(staging, "app", executableName), "fixture");
          await mkdir(join(staging, "installer"));
          let script = renderInnoScript({
            name: "App",
            identifier,
            executableName,
            version: `${version}.0.0`,
            publisher: "Test",
            scope: "perUser",
            payloadDir: join(staging, "app"),
            outputDir: join(staging, "installer"),
            outputBaseName: "setup",
            desktopShortcut: false,
            startMenuShortcut: version === 1,
            webView2: "check",
            appDataDir: join(fixture, "data"),
            preserveUserData: true,
            assetPaths: [],
          }).replaceAll("{group}", menu);
          if (version === 1) {
            script =
              mode === "missing"
                ? script.replace(
                    "SetPreviousData(PreviousDataKey, 'ExecutableName', 'Old.exe');",
                    "",
                  )
                : script.replace(
                    "SetPreviousData(PreviousDataKey, 'InstallDir', ExpandConstant('{app}'));",
                    "SetPreviousData(PreviousDataKey, 'InstallDir', ExpandConstant('{app}') + '-other');",
                  );
          }
          const setup = await compileInno(
            {
              input: input({}),
              staging,
              report() {},
              addArtifact() {},
            },
            script,
            staging,
            "setup",
          );
          await must(setup, [
            "/SP-",
            ...silent,
            `/DIR=${install}`,
          ]);
          const link = await readFile(join(menu, "App.lnk"));
          if (version === 1) {
            previousLink = link;
          } else {
            expect(link).toEqual(previousLink);
          }
          expect(await Bun.file(join(install, "Old.exe")).exists()).toBe(true);
        }
        const uninstall = join(install, "unins000.exe");
        await must(uninstall, silent);
        for (
          let retry = 0;
          retry < 100 && (await Bun.file(uninstall).exists());
          retry++
        ) {
          await Bun.sleep(50);
        }
        expect(await Bun.file(uninstall).exists()).toBe(false);
      }
    } finally {
      await rm(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    }
  },
  60000,
);

const makeappx =
  process.platform === "win32"
    ? await findWindowsKitTool("makeappx.exe")
    : undefined;

test.skipIf(!makeappx)(
  "makeappx accepts explicit automatic and duplicate capabilities",
  async () => {
    if (!makeappx) {
      throw new Error("Expected makeappx.");
    }
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "bunaway-msix-capabilities-")),
    );
    try {
      const payload = join(root, "payload");
      await mkdir(payload);
      await copyFile(
        join(process.env.SystemRoot ?? "C:\\Windows", "System32", "whoami.exe"),
        join(payload, "com.example.app.exe"),
      );
      const logo =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4V8AAAAASUVORK5CYII=";
      await Bun.write(join(payload, "logo.png"), Buffer.from(logo, "base64"));
      await Bun.write(
        join(payload, "AppxManifest.xml"),
        renderAppxManifest({
          packageName: "Bunaway.Test",
          appId: "app.test",
          name: "Test",
          publisherDisplay: "Test",
          publisherIdentity: "CN=Test",
          version: "1.0.0.0",
          minVersion: "10.0.18362.0",
          maxVersionTested: "10.0.26100.0",
          unvirtualizedData: true,
          capabilities: [
            "runFullTrust",
            "unvirtualizedResources",
            "internetClient",
            "internetClient",
          ],
          executable: "com.example.app.exe",
          logo: {
            square44: "logo.png",
            square150: "logo.png",
            storeLogo: "logo.png",
          },
        }),
      );
      await must(makeappx, [
        "pack",
        "/d",
        payload,
        "/p",
        join(root, "test.msix"),
        "/o",
      ]);
      expect(await Bun.file(join(root, "test.msix")).exists()).toBe(true);
    } finally {
      await rm(root, {
        recursive: true,
        force: true,
      });
    }
  },
  30000,
);

test("Windows adapters register all three channels", () => {
  expect(registeredChannels()).toEqual([
    "win-direct",
    "win-store-msix",
    "win-store-unpackaged",
  ]);
  expect(adapterFor("win-direct")?.signingRequirement).toBe("optional");
  expect(adapterFor("win-store-msix")?.signingRequirement).toBe(
    "required-to-run",
  );
  expect(adapterFor("win-store-unpackaged")?.signingRequirement).toBe(
    "required-to-submit",
  );
  expect(adapterFor("mac-direct")).toBeUndefined();
});

test("win-direct stages follow the contract pipeline", () => {
  expect(runIds(adapterOrThrow("win-direct").stages(input({})))).toEqual([
    "stage",
    "sign-runtime",
    "prepare-webview2",
    "assemble",
    "sign-installer",
    "verify-artifact",
  ]);
});

test("win-store-unpackaged adds a submission checklist stage and forbids bootstrap", () => {
  const adapter = adapterOrThrow("win-store-unpackaged");
  const ids = runIds(
    adapter.stages({
      ...input({}),
      channel: "win-store-unpackaged",
    }),
  );
  expect(ids[ids.length - 1]).toBe("submission");
});

test.each([
  "win-direct",
  "win-store-unpackaged",
])("%s rejects machine-wide user data cleanup before packaging", (channel) => {
  const config = (options: Record<string, unknown>) =>
    JSON.stringify({
      channels: {
        [channel]: options,
      },
    });
  expect(() =>
    parsePackaging(
      config({
        scope: "perMachine",
        uninstall: {
          preserveUserData: false,
        },
      }),
    ),
  ).toThrow(/requires scope=perUser/);
  for (const options of [
    {
      scope: "perMachine",
    },
    {
      scope: "perMachine",
      uninstall: {
        preserveUserData: true,
      },
    },
    {
      scope: "perUser",
      uninstall: {
        preserveUserData: false,
      },
    },
    {
      uninstall: {
        preserveUserData: false,
      },
    },
  ]) {
    expect(() => parsePackaging(config(options))).not.toThrow();
  }
});

test("win-store-msix remains registered and fails before SDK discovery", () => {
  const adapter = adapterOrThrow("win-store-msix");
  const findTool = spyOn(windowsTools, "findWindowsKitTool").mockImplementation(
    async () => {
      throw new Error("MSIX gate must run before SDK discovery.");
    },
  );
  try {
    expect(() =>
      adapter.stages({
        ...input({}),
        channel: "win-store-msix",
      }),
    ).toThrow(
      /packaged activation and data paths are unverified.*win-direct.*win-store-unpackaged/,
    );
    expect(findTool).not.toHaveBeenCalled();
  } finally {
    findTool.mockRestore();
  }
});

test("Inno script encodes scope, WebView2 mode, shortcuts and uninstall data policy", () => {
  const base = {
    name: "Test App",
    identifier: "com.example.app",
    version: "1.2.3",
    publisher: "Example",
    payloadDir: "C:\\stage\\app",
    outputDir: "C:\\stage\\installer",
    outputBaseName: "com.example.app-setup-1.2.3",
    desktopShortcut: true,
    startMenuShortcut: true,
    webView2: "check" as const,
    appDataDir: "{localappdata}\\bunaway\\com.example.app",
    preserveUserData: true,
    assetPaths: [
      "WebView2Loader.dll",
      "licenses/LICENSE.bun",
    ],
  };
  const perUser = renderInnoScript({
    ...base,
    scope: "perUser",
  });
  const shortcuts = perUser.split("[Icons]")[1]?.split("[Run]")[0] ?? "";
  expect(shortcuts).toContain('Filename: "{app}\\com.example.app.exe"');
  expect(shortcuts).toContain('AppUserModelID: "com.example.app"');
  expect(shortcuts).not.toContain("powershell.exe");
  const custom = renderInnoScript({
    ...base,
    scope: "perUser",
    executableName: "내 앱's {draft}.exe",
    appId: "app.identity",
  });
  expect(custom).toContain(`Filename: "{app}\\내 앱's {{draft}.exe"`);
  expect(custom).toContain('AppUserModelID: "app.identity"');
  expect(custom).toContain(
    "SetPreviousData(PreviousDataKey, 'ExecutableName', '내 앱''s {draft}.exe')",
  );
  expect(custom).toContain(
    "CompareText(Target, ExpandConstant('{app}') + '\\' + '내 앱''s {draft}.exe') = 0",
  );
  expect(() =>
    renderInnoScript({
      ...base,
      scope: "perUser",
      executableName: "unins000.exe",
    }),
  ).toThrow("uninstaller");
  expect(perUser).toContain(
    "DefaultDirName={localappdata}\\Programs\\com.example.app",
  );
  expect(perUser).toContain("DefaultGroupName=com.example.app");
  expect(perUser).toContain("{autodesktop}\\Test App (com.example.app)");
  expect(perUser).toContain("PrivilegesRequired=lowest");
  expect(perUser).toContain("UninstallLogMode=overwrite");
  expect(perUser).toContain("Current.Add('WebView2Loader.dll')");
  expect(perUser).toContain("if CurStep <> ssPostInstall then Exit");
  expect(perUser).toContain(
    "PreviousExecutableName := GetPreviousData('ExecutableName', '')",
  );
  expect(perUser).toContain(
    "PreviousInstallDir := GetPreviousData('InstallDir', '')",
  );
  expect(perUser).toContain(
    "if not IsSafeExecutableName(PreviousExecutableName) then",
  );
  expect(perUser).toContain(
    [
      "    if (Ord(Name[I]) < 32) or (Name[I] = '<') or (Name[I] = '>') or",
      "       (Name[I] = ':') or (Name[I] = '\"') or (Name[I] = '/') or",
      "       (Name[I] = '\\') or (Name[I] = '|') or (Name[I] = '?') or",
      "       (Name[I] = '*') then Exit;",
    ].join("\n"),
  );
  expect(perUser).not.toContain("Pos(Copy(Name, I, 1)");
  expect(perUser).toContain(
    "CompareText(Target, ExpandConstant('{app}') + '\\' + 'com.example.app.exe') = 0",
  );
  expect(perUser).toContain(
    "SetPreviousData(PreviousDataKey, 'ExecutableName', 'com.example.app.exe')",
  );
  expect(perUser).toContain(
    "SetPreviousData(PreviousDataKey, 'InstallDir', ExpandConstant('{app}'))",
  );
  expect(perUser).toContain(
    "CompareText(AddBackslash(PreviousInstallDir), AddBackslash(ExpandConstant('{app}'))) <> 0",
  );
  expect(perUser).toContain(
    "if CompareText(Path, ExpandConstant('{uninstallexe}')) = 0 then Exit;",
  );
  expect(perUser).toContain(
    "RaiseException('Could not remove previous app executable: ' + Path);",
  );
  expect(perUser).toContain("RemovePreviousExecutable;");
  expect(perUser).toContain("Arguments := Link.Arguments;");
  expect(perUser).toContain("Link.Arguments := Arguments;");
  expect(perUser).not.toContain("PruneShortcuts");
  expect(perUser).toContain("Check: ShouldCreateShortcut(");
  expect(perUser).toContain("AfterInstall: RememberShortcut(");
  expect(perUser).toContain("CurUninstallStepChanged");
  expect(perUser).toContain("Link.Save(Filename);");
  expect(perUser).toContain(
    "procedure RegisterExtraCloseApplicationsResources;",
  );
  expect(perUser).toContain(
    "RegisterExtraCloseApplicationsResource(True, ExpandConstant('{app}') + '\\' + PreviousExecutableName)",
  );
  expect(perUser).toContain("FILE_ATTRIBUTE_REPARSE_POINT");
  expect(perUser).not.toContain("BunawayLauncher");
  expect(perUser).toContain("ArchitecturesAllowed=x64compatible");
  expect(perUser).toContain('Name: "desktopicon"');
  expect(perUser).toContain("{group}\\Test App");
  expect(perUser).toContain("HasWebView2Runtime");
  expect(perUser).toContain("F3017226-FE2A-4295-8BDF-00C3A9A7E4C5");
  expect(perUser).toContain("StrToVersion(Version, PackedVersion)");
  expect(perUser).toContain("ComparePackedVersion(PackedVersion, 0) > 0");
  expect(perUser.match(/and HasRuntimeVersion\(Version\)/g)).toHaveLength(3);
  expect(perUser).not.toContain("MicrosoftEdgeWebview2Setup.exe");
  expect(perUser).not.toContain("[UninstallDelete]");

  const perMachine = renderInnoScript({
    ...base,
    scope: "perMachine",
    bootstrapperPath: "C:\\stage\\webview2\\MicrosoftEdgeWebview2Setup.exe",
    webView2: "bootstrap",
    signed: true,
  });
  expect(perMachine).toContain("DefaultDirName={autopf}\\com.example.app");
  expect(perMachine).toContain("PrivilegesRequired=admin");
  expect(perMachine).not.toContain("RegQueryStringValue(HKCU");
  expect(perMachine).toContain("ArchitecturesAllowed=x64compatible");
  expect(perMachine).not.toContain("[UninstallDelete]");
  expect(() =>
    renderInnoScript({
      ...base,
      scope: "perMachine",
      preserveUserData: false,
    }),
  ).toThrow(/must preserve user data/);
  const perUserCleanup = renderInnoScript({
    ...base,
    scope: "perUser",
    preserveUserData: false,
  });
  expect(perUserCleanup).toContain(
    'Type: filesandordirs; Name: "{localappdata}\\bunaway\\com.example.app"',
  );
  expect(perMachine).toContain("MicrosoftEdgeWebview2Setup.exe");
  const bracePath = "C:\\project\\{demo}\\bootstrapper.exe";
  const braceScript = renderInnoScript({
    ...base,
    scope: "perUser",
    bootstrapperPath: bracePath,
    webView2: "bootstrap",
  });
  expect(braceScript).toContain(`Source: "${bracePath}";`);
  expect(braceScript).not.toContain("C:\\project\\{{demo}");
  expect(() =>
    renderInnoScript({
      ...base,
      scope: "perUser",
      bootstrapperPath: "bad\npath",
    }),
  ).toThrow(/line breaks/);
  expect(perMachine).toContain(
    "'/silent /install', '', SW_HIDE, ewWaitUntilTerminated, ResultCode",
  );
  expect(perMachine).toContain("Flags: dontcopy");
  expect(perMachine).toContain(
    "function PrepareToInstall(var NeedsRestart: Boolean): String",
  );
  expect(perMachine).toContain("else if ResultCode <> 0 then");
  expect(perMachine).toContain("else if not HasWebView2Runtime then");
  expect(perMachine).not.toContain(
    'Filename: "{tmp}\\MicrosoftEdgeWebview2Setup.exe"',
  );
  expect(perUser).toContain("MinVersion=10.0.17763\n");
  expect(
    renderInnoScript({
      ...base,
      scope: "perUser",
      minVersion: "10.0.22621.0",
    }),
  ).toContain("MinVersion=10.0.22621\n");
  for (const minVersion of [
    "6.1",
    "10.0.10240.0",
    "10.0.22621.1",
    "10.0.22621.0\n[Run]",
    "bad",
  ]) {
    expect(() =>
      renderInnoScript({
        ...base,
        scope: "perUser",
        minVersion,
      }),
    ).toThrow(/minVersion/);
  }
  expect(perMachine).toContain("SignTool=bunaway\nSignedUninstaller=yes");
  expect(perUser).not.toContain("SignTool=bunaway");

  const escaped = renderInnoScript({
    ...base,
    scope: "perUser",
    name: 'My "App" {Beta}',
  });
  expect(escaped).toContain('AppName=My "App" {{Beta}');
  expect(escaped).toContain('Description: "Launch My ""App"" {{Beta}"');
  expect(escaped).toContain(
    "DefaultDirName={localappdata}\\Programs\\com.example.app",
  );
  expect(escaped).toContain(
    "{autodesktop}\\My _App_ {{Beta} (com.example.app)",
  );
  for (const scope of [
    "perUser",
    "perMachine",
  ] as const) {
    const first = renderInnoScript({
      ...base,
      scope,
    });
    const second = renderInnoScript({
      ...base,
      scope,
      identifier: "com.other.app",
    });
    for (const directive of [
      "DefaultDirName",
      "DefaultGroupName",
      "AppId",
    ]) {
      const pattern = new RegExp(`^${directive}=.*$`, "m");
      expect(first.match(pattern)?.[0]).not.toBe(second.match(pattern)?.[0]);
    }
    expect(second).toContain("{autodesktop}\\Test App (com.other.app)");
  }
  expect(() =>
    renderInnoScript({
      ...base,
      scope: "perUser",
      name: "App\n[Run]",
    }),
  ).toThrow(/line breaks/);
});

test("AppxManifest declares full trust, virtualization opt-out and icon resources", () => {
  const manifestOptions = {
    packageName: "Example.TestApp",
    appId: "com.example.app",
    name: "Test App",
    publisherDisplay: "Example",
    publisherIdentity: "CN=Example",
    version: "1.2.3.0",
    minVersion: "10.0.18362.0",
    unvirtualizedData: true,
    capabilities: [],
    executable: "com.example.app.exe",
    logo: {
      square44: "Square44x44Logo.png",
      square150: "Square150x150Logo.png",
      storeLogo: "StoreLogo.png",
      wide: "Wide310x150Logo.png",
    },
  };
  const xml = renderAppxManifest(manifestOptions);
  const duplicates = renderAppxManifest({
    ...manifestOptions,
    capabilities: [
      "runFullTrust",
      "unvirtualizedResources",
      "internetClient",
      "internetClient",
    ],
  });
  for (const capability of [
    "runFullTrust",
    "unvirtualizedResources",
    "internetClient",
  ]) {
    expect(
      duplicates.match(new RegExp(`Name="${capability}"`, "g")),
    ).toHaveLength(1);
  }
  expect(() =>
    renderAppxManifest({
      ...manifestOptions,
      minVersion: "10.0.17763.0",
    }),
  ).toThrow(/unvirtualizedData requires minVersion/);
  for (const packageName of [
    "a",
    "ab",
    "a".repeat(51),
  ]) {
    expect(() =>
      renderAppxManifest({
        ...manifestOptions,
        packageName,
      }),
    ).toThrow(/3\.\.50/);
    expect(() =>
      parsePackaging(
        JSON.stringify({
          channels: {
            "win-store-msix": {
              packageName,
            },
          },
        }),
      ),
    ).toThrow();
  }
  for (const packageName of [
    "abc",
    "a".repeat(50),
  ]) {
    expect(() =>
      renderAppxManifest({
        ...manifestOptions,
        packageName,
      }),
    ).not.toThrow();
    expect(() =>
      parsePackaging(
        JSON.stringify({
          channels: {
            "win-store-msix": {
              packageName,
            },
          },
        }),
      ),
    ).not.toThrow();
  }
  expect(xml).toContain('Name="Example.TestApp"');
  expect(xml).toContain('Publisher="CN=Example"');
  expect(xml).toContain('Version="1.2.3.0"');
  expect(xml).toContain('Executable="com.example.app.exe"');
  expect(xml).toContain('EntryPoint="Windows.FullTrustApplication"');
  expect(xml).toContain('Name="runFullTrust"');
  expect(xml).toContain('Name="unvirtualizedResources"');
  expect(xml).toContain(
    "$(KnownFolder:LocalAppData)\\bunaway\\com.example.app",
  );
  expect(xml).toContain("Square44x44Logo.png");
  expect(xml.match(/<uap:VisualElements[^>]*>/)?.[0]).not.toContain(
    "Wide310x150Logo",
  );
  expect(xml).toMatch(
    /<uap:VisualElements[^>]*>\s*<uap:DefaultTile Wide310x150Logo="Wide310x150Logo.png"\/>\s*<\/uap:VisualElements>/,
  );

  const virtualized = renderAppxManifest({
    packageName: "Example.TestApp",
    appId: "com.example.app",
    name: "Test App",
    publisherDisplay: "Example",
    publisherIdentity: "CN=Example",
    version: "1.2.3.0",
    minVersion: "10.0.17763.0",
    unvirtualizedData: false,
    capabilities: [
      "internetClient",
      "privateNetworkClientServer",
      "picturesLibrary",
      "broadFileSystemAccess",
    ],
    executable: "com.example.app.exe",
    logo: {
      square44: "Square44x44Logo.png",
      square150: "Square150x150Logo.png",
      storeLogo: "StoreLogo.png",
    },
  });
  expect(virtualized).not.toContain("unvirtualizedResources");
  expect(virtualized).not.toContain("ExcludedDirectories");
  expect(virtualized).toContain('<Capability Name="internetClient"/>');
  expect(virtualized).toContain(
    '<Capability Name="privateNetworkClientServer"/>',
  );
  expect(virtualized).toContain('<uap:Capability Name="picturesLibrary"/>');
  expect(virtualized).toContain(
    '<rescap:Capability Name="broadFileSystemAccess"/>',
  );
  expect(virtualized).not.toContain(
    '<rescap:Capability Name="privateNetworkClientServer"',
  );
  for (const version of [
    "1.2.3.4",
    "0.1.0.0",
    "65536.0.0.0",
    "1.65536.0.0",
    "1.0.65536.0",
    "1.2.3",
    "1.2.3.0\n",
  ]) {
    expect(() =>
      renderAppxManifest({
        ...manifestOptions,
        version,
      }),
    ).toThrow(/win-store-msix/);
  }
});

test("Windows signing resolves certificates from the project root, independent of cwd", () => {
  const root = resolve(tmpdir(), "bunaway-certificate-project");
  for (const certificateFile of [
    "certs/developer.pfx",
    resolve(tmpdir(), "external.pfx"),
  ]) {
    const ctx: StageContext = {
      input: {
        ...input(
          {},
          {
            certificateFile,
          },
        ),
        metadata: {
          ...metadata,
          root,
        },
      },
      staging: "unused",
      report() {},
      addArtifact() {},
    };
    const args = signingArgs(ctx);
    expect(args[args.indexOf("/f") + 1]).toBe(resolve(root, certificateFile));
  }
});

test("payload staging refuses internal junctions before signing can mutate the build", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bunaway-copy-")));
  try {
    const source = join(root, "source");
    await mkdir(join(source, "real-runtime"), {
      recursive: true,
    });
    await writeFile(
      join(source, "real-runtime", "bun.exe"),
      "original runtime",
    );
    await symlink(
      join(source, "real-runtime"),
      join(source, "runtime"),
      "junction",
    );
    await expect(copyPayload(source, join(root, "stage"))).rejects.toThrow(
      /symlinks or junctions/,
    );
    expect(
      await readFile(join(source, "real-runtime", "bun.exe"), "utf8"),
    ).toBe("original runtime");
  } finally {
    await rm(root, {
      recursive: true,
      force: true,
    });
  }
});

test("plain staged payloads are independent and exclude previous package outputs", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bunaway-copy-")));
  try {
    const source = join(root, "source");
    const stage = join(source, "packaged", "staging");
    await Bun.write(join(source, "com.example.app.exe"), "original runtime");
    await Bun.write(
      join(source, "packaged", "previous", "setup.exe"),
      "previous installer",
    );
    await copyPayload(source, stage);
    await writeFile(join(stage, "com.example.app.exe"), "signed runtime");
    expect(await readFile(join(source, "com.example.app.exe"), "utf8")).toBe(
      "original runtime",
    );
    expect(
      await Bun.file(join(stage, "packaged", "previous", "setup.exe")).exists(),
    ).toBe(false);
  } finally {
    await rm(root, {
      recursive: true,
      force: true,
    });
  }
});

test.each([
  "success",
  "sign",
  "verify",
])("Inno signing callback: %s", async (failure) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bunaway-inno-")));
  try {
    const ctx: StageContext = {
      input: input(
        {},
        {
          certificateFile: "developer.pfx",
          passwordEnv: "BUNAWAY_TEST_PFX_PASSWORD",
        },
      ),
      staging: root,
      report() {},
      addArtifact() {},
    };
    const password = "test-password-never-written";
    const previous = process.env.BUNAWAY_TEST_PFX_PASSWORD;
    process.env.BUNAWAY_TEST_PFX_PASSWORD = password;
    let signing: Awaited<ReturnType<typeof prepareInnoSigning>>;
    try {
      signing = await prepareInnoSigning(ctx, root, "signtool.exe");
    } finally {
      if (previous === undefined) {
        delete process.env.BUNAWAY_TEST_PFX_PASSWORD;
      } else {
        process.env.BUNAWAY_TEST_PFX_PASSWORD = previous;
      }
    }
    const callback = join(root, "inno-signing", "sign.js");
    expect(await readFile(callback, "utf8")).not.toContain(password);
    expect(signing.args.join(" ")).not.toContain(password);
    expect(JSON.parse(signing.env.BUNAWAY_INNO_SIGN_COMMANDS)[0]).toContain(
      password,
    );
    expect(JSON.parse(signing.env.BUNAWAY_INNO_SIGN_COMMANDS)[0]).toContain(
      resolve(ctx.input.metadata.root, "developer.pfx"),
    );
    const trace = join(root, "trace.txt");
    const tool = join(root, "fake-signtool.js");
    await writeFile(
      tool,
      `import { appendFileSync } from "node:fs";
appendFileSync(process.env.TRACE, process.argv[2] + "\\n");
if (process.argv[2] === process.env.FAIL_STAGE) {
  console.error(process.env.BUNAWAY_TEST_PFX_PASSWORD);
  process.exit(1);
}
`,
    );
    const child = Bun.spawn(
      [
        process.execPath,
        callback,
        join(root, "uninstaller.exe"),
      ],
      {
        env: {
          ...signing.env,
          TRACE: trace,
          FAIL_STAGE: failure,
          BUNAWAY_INNO_SIGN_COMMANDS: JSON.stringify([
            [
              process.execPath,
              tool,
              "sign",
            ],
            [
              process.execPath,
              tool,
              "verify",
            ],
          ]),
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code).toBe(failure === "success" ? 0 : 1);
    expect(await readFile(trace, "utf8")).toBe(
      failure === "sign" ? "sign\n" : "sign\nverify\n",
    );
    expect(stdout + stderr).not.toContain(password);
  } finally {
    await rm(root, {
      recursive: true,
      force: true,
    });
  }
});

test("packagedSha256 records the signed app without modifying it", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "bunaway-packaged-hash-")),
  );
  try {
    const upstream = "1".repeat(64);
    const exe = resolve(root, "app.exe");
    await Bun.write(exe, "compiled and signed app");
    await Bun.write(
      resolve(root, "manifest.json"),
      JSON.stringify({
        bun: {
          executableSha256: upstream,
        },
        assets: {},
        app: {
          id: "x",
          version: "1",
        },
        host: {
          target: "windows-x64",
          kind: "bun-compiled",
          executable: "app.exe",
          sha256: upstream,
        },
      }),
    );
    const { recordPackagedHashes } = await import(
      "../../packages/packaging/src/channels/windows/manifest.ts"
    );
    const manifest = await recordPackagedHashes(root);
    expect(manifest.bun.executableSha256).toBe(upstream);
    expect(manifest.host?.sha256).toBe(upstream);
    expect(manifest.host?.packagedSha256).toBe(await windowsTools.sha256(exe));
    expect(await Bun.file(exe).text()).toBe("compiled and signed app");
  } finally {
    await rm(root, {
      recursive: true,
      force: true,
    });
  }
});
