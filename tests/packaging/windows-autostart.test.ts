import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePackaging } from "@bunaway/packaging";
import { findIscc, must } from "#packaging/channels/windows/common";
import {
  type InnoOptions,
  renderInnoScript,
} from "#packaging/channels/windows/inno";
import { innoIdentity } from "#packaging/channels/windows/inno-identity";
import { commandLine } from "#plugins/autostart/src/platforms/windows-launch";

const base: InnoOptions = {
  name: "Autostart fixture",
  identifier: "com.example.installer",
  appId: "app.identity",
  version: "1.0.0",
  publisher: "Test",
  scope: "perUser",
  payloadDir: "C:\\stage\\app",
  outputDir: "C:\\stage\\installer",
  outputBaseName: "setup",
  desktopShortcut: false,
  startMenuShortcut: false,
  webView2: "check",
  appDataDir: "{localappdata}\\bunaway\\app.identity",
  preserveUserData: true,
  assetPaths: [],
  executableName: "App.exe",
};

test("autostart is an explicit per-user EXE installer task", () => {
  for (const channel of [
    "win-direct",
    "win-store-unpackaged",
  ]) {
    const parse = (autostart: unknown, scope = "perUser") =>
      parsePackaging(
        JSON.stringify({
          channels: {
            [channel]: {
              autostart,
              scope,
            },
          },
        }),
      );
    expect(parse(true).channels?.[channel as "win-direct"]?.autostart).toBe(
      true,
    );
    expect(
      parse(false, "perMachine").channels?.[channel as "win-direct"]?.autostart,
    ).toBe(false);
    expect(() => parse("true")).toThrow("boolean");
    expect(() => parse(true, "perMachine")).toThrow("perUser");
  }
  expect(() =>
    parsePackaging(
      JSON.stringify({
        channels: {
          "win-store-msix": {
            autostart: true,
          },
        },
      }),
    ),
  ).toThrow("unknown");
  expect(() =>
    renderInnoScript({
      ...base,
      scope: "perMachine",
      autostart: true,
    }),
  ).toThrow("perUser");
  const script = renderInnoScript({
    ...base,
    autostart: true,
  });
  expect(script).toContain(
    'Name: "autostart"; Description: "로그인 시 자동 실행"; GroupDescription: "자동 실행:"; Flags: unchecked checkedonce',
  );
  expect(script).toContain("Result := 'bunaway.packaged.' + Id;");
  expect(script).toContain("AutostartAppId = 'app.identity'");
  expect(script).toContain(
    "ASSOCIATION_REG_QUERY_VALUE or ASSOCIATION_REG_VIEW_64",
  );
  expect(script).toContain("HKCU64, AutostartRunKey");
  expect(script).not.toContain("StartupApproved\\");
  expect(script).toContain("AUTOSTART_MAX_COMMAND_LENGTH = 260");
  expect(renderInnoScript(base)).not.toContain('Name: "autostart";');
  expect(
    renderInnoScript({
      ...base,
      scope: "perMachine",
    }),
  ).not.toContain("AutostartRunKey");
});

const iscc = process.platform === "win32" ? await findIscc() : undefined;
const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;
const runKey = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const approvedKey =
  "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run";
async function powershell(script: string): Promise<string> {
  const child = Bun.spawn(
    [
      "powershell.exe",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(
        `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); ${script}`,
        "utf16le",
      ).toString("base64"),
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) {
    throw new Error(`PowerShell failed (${code}): ${err}`);
  }
  return out.trim();
}
async function registryValue(key: string, name: string): Promise<string> {
  return powershell(
    `$base=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser,[Microsoft.Win32.RegistryView]::Registry64); $key=$base.OpenSubKey(${quote(key)}); try { if ($key) { $key.GetValue(${quote(name)}, '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) } } finally { if ($key) { $key.Dispose() }; $base.Dispose() }`,
  );
}
async function writeRegistry(key: string, name: string, value: string) {
  await powershell(
    `$base=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser,[Microsoft.Win32.RegistryView]::Registry64); $key=$base.CreateSubKey(${quote(key)}); try { $key.SetValue(${quote(name)},${quote(value)},[Microsoft.Win32.RegistryValueKind]::String) } finally { $key.Dispose(); $base.Dispose() }`,
  );
}
async function deleteRegistryValue(key: string, name: string) {
  await powershell(
    `$base=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser,[Microsoft.Win32.RegistryView]::Registry64); $key=$base.OpenSubKey(${quote(key)},$true); try { if ($key) { $key.DeleteValue(${quote(name)},$false) } } finally { if ($key) { $key.Dispose() }; $base.Dispose() }`,
  );
}
async function runInstaller(path: string, args: string[]): Promise<number> {
  const child = Bun.spawn(
    [
      path,
      "/SP-",
      "/VERYSILENT",
      "/SUPPRESSMSGBOXES",
      "/NORESTART",
      ...args,
    ],
    {
      stdout: "ignore",
      stderr: "ignore",
    },
  );
  return child.exited;
}

/** Real compiled setup/uninstall fixture. Optional isolated Run keys allow ACL faults without changing other apps. */
async function fixture(iscc: string) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "bunaway-autostart-")),
  );
  const identifier = `app.test-${crypto.randomUUID()}`;
  const id = `${identifier}.first`;
  let sequence = 0;
  async function compile(
    destination: string,
    appId = id,
    autostart = true,
    transform = (script: string) => script,
  ) {
    const stage = join(root, `version-${++sequence}`);
    await mkdir(join(stage, "app"), {
      recursive: true,
    });
    await mkdir(join(stage, "installer"));
    await Bun.write(join(stage, "app", "App.exe"), String(sequence));
    const script = transform(
      renderInnoScript({
        ...base,
        identifier,
        appId,
        autostart,
        version: `1.0.${sequence}`,
        payloadDir: join(stage, "app"),
        outputDir: join(stage, "installer"),
      }),
    );
    const source = join(stage, "setup.iss");
    await Bun.write(source, `\uFEFF${script}`);
    await must(iscc, [
      "/Q",
      source,
    ]);
    return {
      setup: join(stage, "installer", "setup.exe"),
      destination,
      payload: String(sequence),
    };
  }
  async function install(
    destination: string,
    appId = id,
    autostart = true,
    tasks = "autostart",
    transform?: (script: string) => string,
  ) {
    const version = await compile(destination, appId, autostart, transform);
    const code = await runInstaller(version.setup, [
      `/DIR=${destination}`,
      `/TASKS=${tasks}`,
    ]);
    return {
      ...version,
      code,
    };
  }
  return {
    root,
    identifier,
    id,
    compile,
    install,
  };
}

test.skipIf(!iscc)(
  "native installer opt-in, update, relocation, ID retirement and foreign ownership preserve user state",
  async () => {
    if (!iscc) {
      throw new Error("Expected ISCC.");
    }
    const f = await fixture(iscc);
    const name = `bunaway.packaged.${f.id}`;
    const nextId = `${f.identifier}.second`;
    const nextName = `bunaway.packaged.${nextId}`;
    const firstDir = join(f.root, "first install");
    const movedDir = join(f.root, "moved 한글");
    const app = (path: string, args: string[] = [], hidden = false) =>
      commandLine(
        {
          id: f.id,
          supportsHiddenStart: true,
          launch: {
            mode: "packaged",
            executablePath: join(path, "App.exe"),
            args: [],
          },
        },
        args,
        hidden,
      );
    const startupState = () =>
      powershell(
        `$key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey(${quote(approvedKey)}); try { [Convert]::ToBase64String($key.GetValue(${quote(name)})) } finally { $key.Dispose() }`,
      );
    try {
      expect((await f.install(firstDir, f.id, true, "")).code).toBe(0);
      expect(await registryValue(runKey, name)).toBe("");
      expect((await f.install(firstDir)).code).toBe(0);
      expect(await registryValue(runKey, name)).toBe(app(firstDir));
      await powershell(
        `$key=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey(${quote(approvedKey)}); try { $key.SetValue(${quote(name)},[byte[]](3,0,0,0,10,20,30,40,50,60,70,80),[Microsoft.Win32.RegistryValueKind]::Binary) } finally { $key.Dispose() }`,
      );
      const disabled = await startupState();
      const args = [
        "--sync",
        "",
        '인용"값',
        "C:\\trailing\\",
      ];
      await writeRegistry(runKey, name, app(firstDir, args, true));
      expect((await f.install(firstDir)).code).toBe(0);
      expect(await registryValue(runKey, name)).toBe(app(firstDir, args, true));
      expect(await startupState()).toBe(disabled);
      // No inherited task recreates a registration the user removed.
      await deleteRegistryValue(runKey, name);
      const uncheckedUpgrade = await f.compile(firstDir);
      expect(
        await runInstaller(uncheckedUpgrade.setup, [
          `/DIR=${firstDir}`,
        ]),
      ).toBe(0);
      expect(await registryValue(runKey, name)).toBe("");
      await writeRegistry(runKey, name, app(firstDir, args, true));
      expect((await f.install(movedDir, f.id, false, "")).code).toBe(0);
      expect(await registryValue(runKey, name)).toBe(app(movedDir, args, true));
      expect(await startupState()).toBe(disabled);
      // Payload relocation does not claim authority to delete the old directory.
      expect(await Bun.file(join(firstDir, "App.exe")).exists()).toBe(true);
      expect((await f.install(movedDir, nextId, false, "")).code).toBe(0);
      expect(await registryValue(runKey, name)).toBe("");
      expect(await registryValue(runKey, nextName)).toBe("");
      expect((await f.install(movedDir, nextId)).code).toBe(0);
      expect(await registryValue(runKey, nextName)).toBe(app(movedDir));
      expect((await f.install(movedDir, nextId, true, "")).code).toBe(0);
      expect(await registryValue(runKey, nextName)).toBe("");
      const foreign = '"C:\\Foreign\\App.exe" "--foreign"';
      await writeRegistry(runKey, nextName, foreign);
      const previousPayload = await Bun.file(join(movedDir, "App.exe")).text();
      expect((await f.install(movedDir, nextId)).code).not.toBe(0);
      expect(await Bun.file(join(movedDir, "App.exe")).text()).toBe(
        previousPayload,
      );
      expect(await registryValue(runKey, nextName)).toBe(foreign);
      expect(await runInstaller(join(movedDir, "unins000.exe"), [])).toBe(0);
      expect(await registryValue(runKey, nextName)).toBe(foreign);
      expect(await startupState()).toBe(disabled);
      // A fresh owned registration is removed by uninstall, including runtime opt-ins.
      await deleteRegistryValue(runKey, nextName);
      expect((await f.install(movedDir, nextId, false, "")).code).toBe(0);
      await writeRegistry(runKey, nextName, app(movedDir));
      expect(await runInstaller(join(movedDir, "unins000.exe"), [])).toBe(0);
      expect(await registryValue(runKey, nextName)).toBe("");
    } finally {
      for (const registration of [
        name,
        nextName,
      ]) {
        await deleteRegistryValue(runKey, registration);
        await deleteRegistryValue(approvedKey, registration);
      }
      await rm(f.root, {
        recursive: true,
        force: true,
      });
    }
  },
  120_000,
);

// All denial tests use an isolated registry key; real RegQuery/Set/Delete calls,
// HKCU64 view and Inno persistence still execute. Never deny the shared Run key.
test.skipIf(!iscc)(
  "native autostart write and retirement failures retain recovery ownership across retry and uninstall",
  async () => {
    if (!iscc) {
      throw new Error("Expected ISCC.");
    }
    const f = await fixture(iscc);
    const key = `Software\\Bunaway\\Tests\\${f.identifier}\\Run`;
    const installDir = join(f.root, "installed");
    const nextId = `${f.identifier}.second`;
    const thirdId = `${f.identifier}.third`;
    const name = `bunaway.packaged.${f.id}`;
    const nextName = `bunaway.packaged.${nextId}`;
    const previousKey = innoIdentity(f.identifier).previousDataKey;
    const pending = () =>
      registryValue(previousKey, "Inno Setup CodeFile: PendingAutostartOwner");
    let restore: (() => Promise<string>) | undefined;
    const isolated = (script: string) =>
      script.replace(
        `AutostartRunKey = '${runKey}'`,
        `AutostartRunKey = '${key}'`,
      );
    async function denyRights(rights: "SetValue" | "QueryValues") {
      const descriptor = await powershell(
        `$key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey(${quote(key)},[Microsoft.Win32.RegistryKeyPermissionCheck]::ReadWriteSubTree,[System.Security.AccessControl.RegistryRights]::ReadPermissions -bor [System.Security.AccessControl.RegistryRights]::ChangePermissions); try { $acl=$key.GetAccessControl([System.Security.AccessControl.AccessControlSections]::Access); $acl.GetSecurityDescriptorSddlForm([System.Security.AccessControl.AccessControlSections]::Access); $rule=[System.Security.AccessControl.RegistryAccessRule]::new([System.Security.Principal.WindowsIdentity]::GetCurrent().User,[System.Security.AccessControl.RegistryRights]::${rights},[System.Security.AccessControl.AccessControlType]::Deny); $acl.AddAccessRule($rule); $key.SetAccessControl($acl) } finally { $key.Dispose() }`,
      );
      return () =>
        powershell(
          `$key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey(${quote(key)},[Microsoft.Win32.RegistryKeyPermissionCheck]::ReadWriteSubTree,[System.Security.AccessControl.RegistryRights]::ChangePermissions); try { $acl=[System.Security.AccessControl.RegistrySecurity]::new(); $acl.SetSecurityDescriptorSddlForm(${quote(descriptor)}); $key.SetAccessControl($acl) } finally { $key.Dispose() }`,
        );
    }
    try {
      expect(
        (await f.install(installDir, f.id, true, "autostart", isolated)).code,
      ).toBe(0);
      const oldCommand = await registryValue(key, name);
      restore = await denyRights("SetValue");
      // New ID requires explicit opt-in; a native write denial must retain old Run.
      expect(
        (await f.install(installDir, nextId, true, "autostart", isolated)).code,
      ).not.toBe(0);
      expect(await registryValue(key, name)).toBe(oldCommand);
      expect(await registryValue(key, nextName)).toBe("");
      expect(await pending()).toBe(`${f.id}|${join(installDir, "App.exe")}`);
      await restore();
      restore = undefined;
      // Model successful new registration followed by failed old retirement. Both
      // values are real and the following retry reaches RegDeleteValue with denied SetValue.
      await writeRegistry(key, nextName, oldCommand);
      restore = await denyRights("SetValue");
      expect(
        (await f.install(installDir, nextId, true, "autostart", isolated)).code,
      ).not.toBe(0);
      expect(await registryValue(key, name)).toBe(oldCommand);
      expect(await registryValue(key, nextName)).toBe(oldCommand);
      expect(await pending()).toBe(`${f.id}|${join(installDir, "App.exe")}`);
      const before = await Bun.file(join(installDir, "App.exe")).text();
      expect(
        (await f.install(installDir, thirdId, true, "autostart", isolated))
          .code,
      ).not.toBe(0);
      expect(await Bun.file(join(installDir, "App.exe")).text()).toBe(before);
      await restore();
      restore = undefined;
      expect(
        (await f.install(installDir, nextId, true, "autostart", isolated)).code,
      ).toBe(0);
      expect(await registryValue(key, name)).toBe("");
      expect(await registryValue(key, nextName)).toBe(oldCommand);
      expect(await pending()).toBe("");
      const stablePayload = await Bun.file(join(installDir, "App.exe")).text();
      restore = await denyRights("QueryValues");
      expect(
        (await f.install(installDir, nextId, true, "autostart", isolated)).code,
      ).not.toBe(0);
      expect(await Bun.file(join(installDir, "App.exe")).text()).toBe(
        stablePayload,
      );
      await restore();
      restore = undefined;
      await powershell(
        `$key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey(${quote(key)},$true); try { $key.SetValue(${quote(nextName)},42,[Microsoft.Win32.RegistryValueKind]::DWord) } finally { $key.Dispose() }`,
      );
      expect(
        (await f.install(installDir, nextId, true, "autostart", isolated)).code,
      ).not.toBe(0);
      expect(await registryValue(key, nextName)).toBe("42");
      expect(await Bun.file(join(installDir, "App.exe")).text()).toBe(
        stablePayload,
      );
      const oversized = `${oldCommand} "${"x".repeat(260)}"`;
      await writeRegistry(key, nextName, oversized);
      expect(
        (await f.install(installDir, nextId, true, "autostart", isolated)).code,
      ).not.toBe(0);
      expect(await registryValue(key, nextName)).toBe(oversized);
      expect(await Bun.file(join(installDir, "App.exe")).text()).toBe(
        stablePayload,
      );
      await writeRegistry(key, nextName, oldCommand);
      restore = await denyRights("SetValue");
      expect(await runInstaller(join(installDir, "unins000.exe"), [])).not.toBe(
        0,
      );
      expect(await Bun.file(join(installDir, "App.exe")).exists()).toBe(true);
      expect(await registryValue(key, nextName)).toBe(oldCommand);
      await restore();
      restore = undefined;
      expect(await runInstaller(join(installDir, "unins000.exe"), [])).toBe(0);
      expect(await registryValue(key, nextName)).toBe("");
    } finally {
      if (restore) {
        await restore();
      }
      await powershell(
        `[Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree(${quote(`Software\\Bunaway\\Tests\\${f.identifier}`)},$false)`,
      );
      await rm(f.root, {
        recursive: true,
        force: true,
      });
    }
  },
  120_000,
);

test.skipIf(!iscc)(
  "native Run ownership inspection excludes runtime writers and installers with another installation ID",
  async () => {
    if (!iscc) {
      throw new Error("Expected ISCC.");
    }
    const f = await fixture(iscc);
    const other = await fixture(iscc);
    const name = `bunaway.packaged.${f.id}`;
    const installDir = join(f.root, "installed");
    const otherDir = join(other.root, "installed");
    const ready = join(f.root, "retirement-ready");
    const release = join(f.root, "retirement-release");
    const gate = (script: string) => {
      const inspection = `  if QueryAutostartCommand(Owner.AppId, Command) and IsAutostartCommandOwner(Command, Owner) then
    if not RegDeleteValue(HKCU64, AutostartRunKey, AutostartName(Owner.AppId)) then
      RaiseException('Could not remove owned autostart registration.');`;
      expect(script).toContain(inspection);
      return script.replace(
        inspection,
        `  if QueryAutostartCommand(Owner.AppId, Command) and IsAutostartCommandOwner(Command, Owner) then begin
    if not SaveStringToFile(${quote(ready)}, 'ready', False) then RaiseException('Could not publish retirement gate.');
    while not FileExists(${quote(release)}) do Sleep(20);
    if not RegDeleteValue(HKCU64, AutostartRunKey, AutostartName(Owner.AppId)) then
      RaiseException('Could not remove owned autostart registration.');
  end;`,
      );
    };
    const runtimeSource = join(f.root, "runtime-writer.ts");
    // Import the actual native entrypoint, including its read/compare/write path.
    const { fileURLToPath } = await import("node:url");
    const runtimeModule = fileURLToPath(
      new URL(
        "../../plugins/autostart/src/platforms/windows.ts",
        import.meta.url,
      ),
    );
    await Bun.write(
      runtimeSource,
      `
import { initialize, enable, dispose } from ${JSON.stringify(runtimeModule)};
const state = initialize({ dataRoot: '.', capabilities: [], app: {
  id: ${JSON.stringify(f.id)}, launch: { mode: 'packaged', executablePath: 'C:\\\\Foreign\\\\App.exe', args: [] }
} });
try {
  enable(state, { args: ['--replacement'] });
  console.log('UPDATED');
} catch (error) {
  if (error?.code !== 'BUSY') throw error;
  console.log('BUSY');
} finally { dispose(state); }
`,
    );
    async function runtimeWriter() {
      const child = Bun.spawn(
        [
          process.execPath,
          runtimeSource,
        ],
        {
          stdout: "pipe",
          stderr: "pipe",
          timeout: 15000,
        },
      );
      const [out, err, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(code, err).toBe(0);
      return out.trim();
    }
    let uninstaller: ReturnType<typeof Bun.spawn> | undefined;
    try {
      expect(
        (await f.install(installDir, f.id, true, "autostart", gate)).code,
      ).toBe(0);
      const original = await registryValue(runKey, name);
      await powershell(
        `$key=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey(${quote(approvedKey)}); try { $key.SetValue(${quote(name)},[byte[]](3,0,0,0,10,20,30,40,50,60,70,80),[Microsoft.Win32.RegistryValueKind]::Binary) } finally { $key.Dispose() }`,
      );
      const approval = () =>
        powershell(
          `$key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey(${quote(approvedKey)}); try { [Convert]::ToBase64String($key.GetValue(${quote(name)})) } finally { $key.Dispose() }`,
        );
      const disabled = await approval();
      uninstaller = Bun.spawn(
        [
          join(installDir, "unins000.exe"),
          "/VERYSILENT",
          "/SUPPRESSMSGBOXES",
          "/NORESTART",
        ],
        {
          stdout: "ignore",
          stderr: "ignore",
          timeout: 45000,
        },
      );
      const deadline = Date.now() + 10000;
      while (!(await Bun.file(ready).exists()) && Date.now() < deadline) {
        await Bun.sleep(20);
      }
      expect(await Bun.file(ready).exists()).toBe(true);
      expect(await runtimeWriter()).toBe("BUSY");
      expect(await registryValue(runKey, name)).toBe(original);
      const contender = await other.compile(otherDir, f.id);
      const log = join(other.root, "contender.log");
      expect(
        await runInstaller(contender.setup, [
          `/DIR=${otherDir}`,
          "/TASKS=autostart",
          `/LOG=${log}`,
        ]),
      ).not.toBe(0);
      expect(await Bun.file(log).text()).toContain(
        "Another process is maintaining this autostart registration.",
      );
      expect(await Bun.file(join(otherDir, "App.exe")).exists()).toBe(false);
      expect(await registryValue(runKey, name)).toBe(original);
      expect(await approval()).toBe(disabled);
      await Bun.write(release, "release");
      expect(await uninstaller.exited).toBe(0);
      expect(await registryValue(runKey, name)).toBe("");
      expect(
        await runInstaller(contender.setup, [
          `/DIR=${otherDir}`,
          "/TASKS=autostart",
        ]),
      ).toBe(0);
      expect(await registryValue(runKey, name)).toContain(
        join(otherDir, "App.exe"),
      );
      expect(await runtimeWriter()).toBe("UPDATED");
      const foreign = await registryValue(runKey, name);
      expect(foreign).toContain('"C:\\Foreign\\App.exe"');
      expect(await runInstaller(join(otherDir, "unins000.exe"), [])).toBe(0);
      expect(await registryValue(runKey, name)).toBe(foreign);
      expect(await approval()).toBe(disabled);
    } finally {
      await Bun.write(release, "release");
      if (uninstaller) {
        await uninstaller.exited;
      }
      await deleteRegistryValue(runKey, name);
      await deleteRegistryValue(approvedKey, name);
      await rm(f.root, {
        recursive: true,
        force: true,
      });
      await rm(other.root, {
        recursive: true,
        force: true,
      });
    }
  },
  120_000,
);
