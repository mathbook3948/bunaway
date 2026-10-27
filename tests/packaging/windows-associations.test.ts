import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type ChannelConfig, parsePackaging } from "@bunaway/packaging";
import { openRequest } from "#native/windows/bun/desktop";
import { findIscc, must, stableGuid } from "#packaging/channels/windows/common";
import { renderInnoScript } from "#packaging/channels/windows/inno";
import { innoIdentity } from "#packaging/channels/windows/inno-identity";
import { installationMutexNames } from "#packaging/channels/windows/installation-state";
import { deadline } from "../fixtures/deadlines.ts";

const associations = {
  files: [
    {
      extension: ".NOTE",
      name: "Notes 파일 {문서}",
      mimeType: "application/x-notes",
    },
  ],
  urlSchemes: [
    {
      scheme: "notes",
      name: "Notes URL",
    },
  ],
};

test("installer association config normalizes keys and rejects unsafe or ambiguous declarations", () => {
  const parse = (value: unknown, channel = "win-direct") =>
    parsePackaging(
      JSON.stringify({
        channels: {
          [channel]: {
            associations: value,
          },
        },
      }),
    );
  expect(
    parse(associations).channels?.["win-direct"]?.associations?.files?.[0]
      ?.extension,
  ).toBe(".note");
  // TAB and astral characters are valid XML text and stay accepted.
  expect(() =>
    parse({
      files: [
        {
          extension: ".a",
          name: "A\tB \u{1F4DD}",
        },
      ],
    }),
  ).not.toThrow();
  expect(
    parse(associations, "win-store-unpackaged").channels?.[
      "win-store-unpackaged"
    ]?.associations,
  ).toBeDefined();
  for (const value of [
    {},
    {
      files: [],
    },
    {
      files: [
        {
          extension: "note",
          name: "Notes",
        },
      ],
    },
    {
      files: [
        {
          extension: ".a\\b",
          name: "Notes",
        },
      ],
    },
    {
      files: [
        {
          extension: ".a",
          name: "Notes",
          icon: "other.exe",
        },
      ],
    },
    {
      files: [
        {
          extension: ".a",
          name: "Notes",
          mimeType: "bad",
        },
      ],
    },
    {
      files: [
        {
          extension: ".a",
          name: "Notes\n[Code]",
        },
      ],
    },
    {
      files: [
        {
          extension: ".a",
          name: "Notes\u000b",
        },
      ],
    },
    {
      files: [
        {
          extension: ".a",
          name: "Notes\ud800",
        },
      ],
    },
    {
      files: [
        {
          extension: ".a",
          name: "Notes\uffff",
        },
      ],
    },
    {
      files: [
        {
          extension: ".a",
          name: "Notes\x7f",
        },
      ],
    },
    {
      files: [
        {
          extension: ".a",
          name: "A",
        },
        {
          extension: ".A",
          name: "B",
        },
      ],
    },
    {
      urlSchemes: [
        {
          scheme: "notes:",
          name: "Notes",
        },
      ],
    },
    {
      urlSchemes: [
        {
          scheme: "notes",
          name: "A",
        },
        {
          scheme: "NOTES",
          name: "B",
        },
      ],
    },
    {
      files: Array.from(
        {
          length: 33,
        },
        (_, i) => ({
          extension: `.x${i}`,
          name: "X",
        }),
      ),
    },
  ]) {
    expect(() => parse(value)).toThrow();
  }
  expect(() => parse(associations, "mac-direct")).toThrow("unknown field");
});

test("installer URL schemes preserve desktop drive parsing and reach onOpen as URLs", () => {
  for (const channel of [
    "win-direct",
    "win-store-unpackaged",
  ] as const) {
    const parse = (scheme: string) =>
      parsePackaging(
        JSON.stringify({
          channels: {
            [channel]: {
              associations: {
                urlSchemes: [
                  {
                    scheme,
                    name: "Test links",
                  },
                ],
              },
            },
          },
        }),
      ).channels?.[channel]?.associations?.urlSchemes?.[0]?.scheme;
    for (const scheme of "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ") {
      expect(() => parse(scheme)).toThrow("Invalid scheme");
    }
    for (const scheme of [
      "x1",
      "NoTeS",
      "notes+item",
      "n".repeat(32),
    ]) {
      const normalized = parse(scheme);
      expect(normalized).toBe(scheme.toLowerCase());
      const request = openRequest(
        {
          argv: [
            `${normalized}://host/item`,
          ],
          cwd: "X:\\launch",
        },
        "initial",
      );
      expect(request.urls).toEqual([
        `${normalized}://host/item`,
      ]);
      expect(request.files).toEqual([]);
    }
    expect(() => parse("n".repeat(33))).toThrow("Invalid scheme");
  }
  const request = openRequest(
    {
      argv: [
        "x://host/item",
        "X:\\notes.txt",
        "X:notes.txt",
      ],
      cwd: "X:\\launch",
    },
    "initial",
  );
  expect(request.urls).toEqual([]);
  expect(request.files).toEqual([
    "x:\\host\\item",
    "X:\\notes.txt",
    "X:\\launch\\notes.txt",
  ]);
});

const script = (
  identifier: string,
  payloadDir: string,
  outputDir: string,
  executableName: string,
  declarations?: ChannelConfig["associations"],
  payloadListPath?: string,
  shortcuts = false,
) =>
  renderInnoScript({
    name: "연결 App {문서}",
    identifier,
    version: "1.0.0",
    publisher: "Tests",
    scope: "perUser",
    payloadDir,
    outputDir,
    outputBaseName: "setup",
    executableName,
    desktopShortcut: shortcuts,
    startMenuShortcut: shortcuts,
    webView2: "check",
    appDataDir: "{localappdata}\\bunaway\\association-test",
    preserveUserData: true,
    assetPaths: [],
    ...(payloadListPath
      ? {
          payloadListPath,
        }
      : {}),
    ...(declarations
      ? {
          associations: declarations,
        }
      : {}),
  });

test("association installer tasks are unchecked and quote executable and argument separately", () => {
  const rendered = script(
    "tests.associations",
    "payload",
    "output",
    "연결 {App}.exe",
    associations,
  );
  expect(rendered).toContain(
    'Name: "fileassociations"; Description: "파일 열기 앱으로 등록"; GroupDescription: "앱 연결:"; Flags: unchecked',
  );
  expect(rendered).toContain(
    'Name: "urlschemes"; Description: "URL 열기 앱으로 등록"; GroupDescription: "앱 연결:"; Flags: unchecked',
  );
  expect(rendered).toContain(
    "ExpandConstant('{app}') + '\\' + '연결 {App}.exe'",
  );
  expect(rendered).toContain("Result := '\"' + Executable + '\" \"%1\"';");
  expect(rendered).toContain("ChangesAssociations=yes");
  // The existing escaped identity expands to two closing braces. This exact
  // value is the installer/update boundary, including for previous-data recovery.
  expect(rendered).toContain("AppId={{82a2d7f4-507d-81d4-0c9e-1e149663006b}}");
  expect(rendered).toContain(
    "Uninstall\\{82a2d7f4-507d-81d4-0c9e-1e149663006b}}_is1';",
  );
  expect(rendered).toContain("Notes 파일 {문서}");
  expect(rendered).not.toContain(
    "WriteAssociationValue('Software\\Classes\\notes'",
  );
});

/** Hold a real Windows handle without delete sharing until the caller releases it. */
async function preventFileDeletion(path: string) {
  const { dlopen, ptr } = await import("bun:ffi");
  const GENERIC_READ = 0x80000000;
  const FILE_SHARE_READ_WRITE = 0x3;
  const OPEN_EXISTING = 3;
  const INVALID_HANDLE_VALUE = 0xffffffffffffffffn;
  const library = dlopen("kernel32.dll", {
    CreateFileW: {
      args: [
        "ptr",
        "u32",
        "u32",
        "ptr",
        "u32",
        "u32",
        "u64",
      ],
      returns: "u64",
    },
    CloseHandle: {
      args: [
        "u64",
      ],
      returns: "i32",
    },
  });
  const filename = Buffer.from(`${path}\0`, "utf16le");
  const handle = library.symbols.CreateFileW(
    ptr(filename),
    GENERIC_READ,
    FILE_SHARE_READ_WRITE,
    null,
    OPEN_EXISTING,
    0,
    0n,
  );
  if (handle === 0n || handle === INVALID_HANDLE_VALUE) {
    library.close();
    throw new Error(`Could not lock fixture against deletion: ${path}`);
  }
  return () => {
    try {
      expect(library.symbols.CloseHandle(handle)).not.toBe(0);
    } finally {
      library.close();
    }
  };
}

/** Probe real ownership and release the probe, including an abandoned previous process. */
async function maintenanceAvailable(name: string) {
  const { dlopen, ptr } = await import("bun:ffi");
  const WAIT_ACQUIRED = 0;
  const WAIT_ABANDONED = 128;
  const WAIT_TIMEOUT = 258;
  const api = dlopen("kernel32.dll", {
    CreateMutexW: {
      args: [
        "ptr",
        "i32",
        "ptr",
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
    ReleaseMutex: {
      args: [
        "u64",
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
  const handle = api.symbols.CreateMutexW(
    null,
    0,
    ptr(Buffer.from(`${name}\0`, "utf16le")),
  );
  if (handle === 0n) {
    api.close();
    throw new Error("Could not create the fixture maintenance probe.");
  }
  try {
    const status = api.symbols.WaitForSingleObject(handle, 0);
    if (status === WAIT_TIMEOUT) {
      return false;
    }
    expect([
      WAIT_ACQUIRED,
      WAIT_ABANDONED,
    ]).toContain(status);
    expect(api.symbols.ReleaseMutex(handle)).not.toBe(0);
    return true;
  } finally {
    expect(api.symbols.CloseHandle(handle)).not.toBe(0);
    api.close();
  }
}

interface NativeGate {
  ready: string;
  release: string;
}

type InstallerFailure =
  | "collision"
  | "write"
  | "cleanup"
  | "payload-cleanup"
  | "relocation-cleanup"
  | "pending-owner"
  | "busy"
  | "stale"
  | "read-preflight"
  | "read"
  | "key-cleanup"
  | "metadata"
  | "metadata-preflight";

interface NativeInstallerRequest {
  version: string;
  executable: string;
  config: ChannelConfig["associations"];
  tasks?: string;
  failure?: InstallerFailure;
  fault?: "icon" | "mapping";
  destination?: string;
  // Extra payload files (Windows relative paths) written to the payload and listed for relocation cleanup.
  payloadFiles?: string[];
  // Also create the start menu, uninstall and desktop links.
  shortcuts?: boolean;
  setupGate?: NativeGate;
  uninstallGate?: NativeGate;
  legacySetup?: boolean;
}

/** Wait for an actual paused native callback, without guessing installer timing. */
async function waitForGate(gate: NativeGate) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (await Bun.file(gate.ready).exists()) {
      return;
    }
    await Bun.sleep(50);
  }
  throw new Error(`Native installer did not reach fixture gate: ${gate.ready}`);
}

/** Observe completion while a callback is paused, and always release/wait without hiding assertion failures. */
async function whileGated(
  running: {
    finish(): Promise<void>;
  },
  gate: NativeGate,
  action: () => Promise<void>,
) {
  const completion = Promise.allSettled([
    running.finish(),
  ]);
  let completionResult: PromiseSettledResult<void> | undefined;
  try {
    await waitForGate(gate);
    await action();
  } finally {
    await Bun.write(gate.release, "release");
    [completionResult] = await completion;
    if (completionResult.status === "rejected") {
      console.error(completionResult.reason);
    }
  }
  if (completionResult?.status === "rejected") {
    throw completionResult.reason;
  }
}

/** Failures that lock an old executable on purpose, so Restart Manager must not close the test process. */
function holdsLockedExecutable(failure: InstallerFailure | undefined) {
  return (
    failure === "payload-cleanup" ||
    failure === "relocation-cleanup" ||
    failure === "pending-owner"
  );
}

/** Writes the extra payload files and the list that relocation cleanup unpacks, when the request has any. */
async function stagePayloadFiles(
  payload: string,
  listPath: string,
  executable: string,
  request: NativeInstallerRequest,
) {
  const files = request.payloadFiles;
  if (!files) {
    return;
  }
  for (const file of files) {
    await Bun.write(join(payload, file), "installer payload fixture");
  }
  await Bun.write(
    listPath,
    `\ufeff${[
      executable,
      ...files,
    ].join("\r\n")}\r\n`,
  );
}

async function createNativeAssociationFixture(compiler: string) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "bunaway-associations-")),
  );
  const identifier = `tests.associations-${crypto.randomUUID()}`;
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const extension = `.b${suffix.slice(0, 20)}`;
  const scheme = `b${suffix.slice(0, 20)}`;
  const associationRoot = `Software\\Bunaway\\Associations\\${stableGuid(identifier)}`;
  const previousDataKey = innoIdentity(identifier).previousDataKey;
  const unexpectedPreviousDataKey = previousDataKey.replace("}}_is1", "}_is1");
  const registration = `연결 App {문서} (${identifier})`;
  const fileProgId = `BW.${stableGuid(`${identifier}:file:${extension}`).replaceAll("-", "")}`;
  const urlProgId = `BW.${stableGuid(`${identifier}:url:${scheme}`).replaceAll("-", "")}`;
  const installDir = join(root, "앱 설치");
  const declarations = {
    files: [
      {
        extension,
        name: "문서",
        mimeType: "application/x-test",
      },
    ],
    urlSchemes: [
      {
        scheme,
        name: "링크",
      },
    ],
  };
  const silent = [
    "/VERYSILENT",
    "/SUPPRESSMSGBOXES",
    "/NORESTART",
  ];
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const mutexes = installationMutexNames(identifier);
  function renderGate(event: string, gate: NativeGate) {
    const ready = gate.ready.replaceAll("'", "''");
    const release = gate.release.replaceAll("'", "''");
    return `\n// Test-only pause after initialization, before any native mutation.\nprocedure ${event};\nvar I: Integer;\nbegin\n  if not SaveStringToFile('${ready}', 'ready', False) then RaiseException('Fixture gate marker failed.');\n  for I := 1 to 1800 do begin\n    if FileExists('${release}') then Exit;\n    Sleep(50);\n  end;\n  RaiseException('Fixture gate timed out.');\nend;\n`;
  }
  async function powershell(body: string) {
    const child = Bun.spawn(
      [
        "powershell.exe",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$ErrorActionPreference='Stop'; $OutputEncoding=[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); ${body}`,
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const output = await new Response(child.stdout).text();
    const error = await new Response(child.stderr).text();
    if ((await child.exited) !== 0) {
      throw new Error(error);
    }
    return output.trim();
  }
  const query = (path: string, name = "") =>
    powershell(
      `$key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey(${quote(path)}); if ($key) { try { $key.GetValue(${quote(name)},'MISSING') } finally { $key.Dispose() } } else { 'MISSING' }`,
    );
  const write = (path: string, name: string, value: string) =>
    powershell(
      `$key=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey(${quote(path)}); try { $key.SetValue(${quote(name)},${quote(value)}) } finally { $key.Dispose() }`,
    );
  const registryKeyExists = async (path: string) =>
    (await powershell(
      `$key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey(${quote(path)}); $exists=$null -ne $key; if ($key) { $key.Dispose() }; $exists.ToString().ToLowerInvariant()`,
    )) === "true";
  const restoreAccess = (path: string, descriptor: string) =>
    powershell(
      `$key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey(${quote(path)},[Microsoft.Win32.RegistryKeyPermissionCheck]::ReadWriteSubTree,[System.Security.AccessControl.RegistryRights]::ChangePermissions); try { $acl=[System.Security.AccessControl.RegistrySecurity]::new(); $acl.SetSecurityDescriptorSddlForm(${quote(descriptor)},[System.Security.AccessControl.AccessControlSections]::Access); $key.SetAccessControl($acl) } finally { $key.Dispose() }`,
    );
  async function denyRegistryRights(
    path: string,
    rights: "SetValue" | "QueryValues" | "Delete",
  ) {
    const descriptor = await powershell(
      `$key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey(${quote(path)},[Microsoft.Win32.RegistryKeyPermissionCheck]::ReadWriteSubTree,[System.Security.AccessControl.RegistryRights]::ReadPermissions -bor [System.Security.AccessControl.RegistryRights]::ChangePermissions); try { $acl=$key.GetAccessControl([System.Security.AccessControl.AccessControlSections]::Access); $acl.GetSecurityDescriptorSddlForm([System.Security.AccessControl.AccessControlSections]::Access); $rule=[System.Security.AccessControl.RegistryAccessRule]::new([System.Security.Principal.WindowsIdentity]::GetCurrent().User,[System.Security.AccessControl.RegistryRights]::${rights},[System.Security.AccessControl.AccessControlType]::Deny); $acl.AddAccessRule($rule); $key.SetAccessControl($acl) } finally { $key.Dispose() }`,
    );
    return () => restoreAccess(path, descriptor);
  }
  const denyValueWrites = (path: string) =>
    denyRegistryRights(path, "SetValue");
  async function verifyQueryOnlyDenial(path: string) {
    // This fixture must still permit recursive enumeration/deletion. Otherwise
    // a preserved foreign command would not prove reads failed closed.
    await powershell(
      `$key=$null; try { $key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey(${quote(path)},[Microsoft.Win32.RegistryKeyPermissionCheck]::Default,[System.Security.AccessControl.RegistryRights]::QueryValues) } catch [System.Security.SecurityException], [System.UnauthorizedAccessException] {} ; if ($key) { $key.Dispose(); throw 'Fixture QueryValues denial did not apply.' }; $key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey(${quote(path)},[Microsoft.Win32.RegistryKeyPermissionCheck]::Default,[System.Security.AccessControl.RegistryRights]::EnumerateSubKeys -bor [System.Security.AccessControl.RegistryRights]::Delete); if (-not $key) { throw 'Fixture lost enumeration/deletion access.' }; $key.Dispose()`,
    );
  }
  async function restoreRegistrationFault(
    version: string,
    fault: "icon" | "mapping",
  ) {
    const descriptor = await Bun.file(join(root, version, "acl.txt")).text();
    await restoreAccess(
      fault === "icon"
        ? `Software\\Classes\\${fileProgId}\\DefaultIcon`
        : `${associationRoot}\\Capabilities\\FileAssociations`,
      descriptor.trim(),
    );
  }
  async function startInstall(request: NativeInstallerRequest) {
    const {
      version,
      executable,
      config,
      tasks,
      failure,
      fault,
      destination = installDir,
    } = request;
    const staging = join(root, version);
    const payload = join(staging, "app");
    const output = join(staging, "installer");
    await mkdir(payload, {
      recursive: true,
    });
    await mkdir(output);
    await Bun.write(join(payload, executable), "installer payload fixture");
    const payloadList = join(staging, "payload-files.txt");
    await stagePayloadFiles(payload, payloadList, executable, request);
    const iss = join(staging, "setup.iss");
    let rendered = script(
      identifier,
      payload,
      output,
      executable,
      config,
      request.payloadFiles ? payloadList : undefined,
      request.shortcuts,
    );
    if (request.legacySetup) {
      // Model a previous installer which did not participate in coordination.
      // Registry/payload operations and snapshot validation still execute natively.
      const acquisition =
        "  Result := AcquireInstallationMaintenance;\n  if not Result then Exit;\n";
      expect(rendered).toContain(acquisition);
      rendered = rendered.replace(acquisition, "  Result := True;\n");
      rendered = rendered.replace(`SetupMutex=${mutexes.setup}\n`, "");
    }
    if (request.setupGate) {
      rendered += renderGate("InitializeWizard", request.setupGate);
    }
    if (request.uninstallGate) {
      rendered += renderGate(
        "InitializeUninstallProgressForm",
        request.uninstallGate,
      );
    }
    if (holdsLockedExecutable(failure)) {
      // The dummy EXE cannot run. Keep Restart Manager from closing the test
      // process that owns the deliberate no-delete-sharing handle.
      rendered = rendered.replace(
        "CloseApplications=yes",
        "CloseApplications=no",
      );
    }
    if (fault) {
      // Test-only injection creates a real ACL denial at the precise native
      // write boundary, after preflight. No production binding is mocked.
      const path =
        fault === "icon"
          ? `Software\\Classes\\${fileProgId}\\DefaultIcon`
          : `${associationRoot}\\Capabilities\\FileAssociations`;
      const aclScript = join(staging, "deny.ps1");
      await Bun.write(
        aclScript,
        `$ErrorActionPreference='Stop'; $created=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey(${quote(path)}); $created.Dispose(); $key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey(${quote(path)},[Microsoft.Win32.RegistryKeyPermissionCheck]::ReadWriteSubTree,[System.Security.AccessControl.RegistryRights]::ReadPermissions -bor [System.Security.AccessControl.RegistryRights]::ChangePermissions); try { $acl=$key.GetAccessControl([System.Security.AccessControl.AccessControlSections]::Access); [System.IO.File]::WriteAllText(${quote(join(staging, "acl.txt"))},$acl.GetSecurityDescriptorSddlForm([System.Security.AccessControl.AccessControlSections]::Access)); $rule=[System.Security.AccessControl.RegistryAccessRule]::new([System.Security.Principal.WindowsIdentity]::GetCurrent().User,[System.Security.AccessControl.RegistryRights]::SetValue,[System.Security.AccessControl.AccessControlType]::Deny); $acl.AddAccessRule($rule); $key.SetAccessControl($acl) } finally { $key.Dispose() }`,
      );
      const target =
        fault === "icon"
          ? "  WriteAssociationValue(Key + '\\DefaultIcon', '', '\"' + AssociationExecutable + '\",0');"
          : "  WriteAssociationValue(AssociationRoot + '\\Capabilities\\' + Kind, Token, ProgId);";
      expect(rendered).toContain(target);
      rendered = rendered.replace(
        "var PreviousExecutableName: String;",
        "var TestRegistryFaultExitCode: Integer;\n    PreviousExecutableName: String;",
      );
      rendered = rendered.replace(
        target,
        `  if ProgId = '${fileProgId}' then begin\n    if not Exec(ExpandConstant('{sys}\\WindowsPowerShell\\v1.0\\powershell.exe'), '-NoProfile -NonInteractive -File "${aclScript.replaceAll("'", "''")}"', '', SW_HIDE, ewWaitUntilTerminated, TestRegistryFaultExitCode) or (TestRegistryFaultExitCode <> 0) then\n      RaiseException('Fixture could not deny registry write.');\n  end;\n${target}`,
      );
    }
    await Bun.write(iss, `\ufeff${rendered}`);
    await must(compiler, [
      "/Q",
      iss,
    ]);
    const logPath = join(staging, "install.log");
    const child = Bun.spawn(
      [
        join(output, "setup.exe"),
        ...silent,
        `/DIR=${destination}`,
        `/LOG=${logPath}`,
        ...(tasks !== undefined
          ? [
              `/TASKS=${tasks}`,
            ]
          : []),
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    async function finish() {
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      const log = await Bun.file(logPath).text();
      if (failure) {
        expect(exitCode).not.toBe(0);
        if (
          failure === "pending-owner" ||
          failure === "stale" ||
          failure === "read-preflight" ||
          failure === "metadata-preflight"
        ) {
          // PrepareToInstall rejects the rename before payload and previous-data writes.
          expect(exitCode).toBe(7);
        } else if (failure === "busy") {
          expect(exitCode).toBe(1);
        } else if (failure !== "collision") {
          expect(exitCode).toBe(1);
        }
        const failureMessages = {
          collision: "App association is owned by a different command",
          write: "Could not register app association",
          cleanup: "Could not remove app association value",
          "payload-cleanup": "Could not remove previous app executable",
          "relocation-cleanup": "Could not remove the previous installation",
          "pending-owner": "Complete the previous executable cleanup",
          busy: "Another setup or uninstall is maintaining this application",
          stale:
            "Installation state changed while this setup or uninstall was open",
          "read-preflight": "Could not inspect app association",
          read: "Could not inspect app association",
          "key-cleanup": "Could not remove app association key",
          metadata: "Could not read installation identity",
          "metadata-preflight": "Could not read installation identity",
        };
        expect(log).toContain(failureMessages[failure]);
      } else if (exitCode !== 0) {
        throw new Error(
          `Installer failed (${exitCode}): ${stdout} ${stderr}\n${log}`,
        );
      }
    }
    return {
      child,
      logPath,
      finish,
    };
  }
  async function install(
    version: string,
    executable: string,
    config: ChannelConfig["associations"],
    tasks?: string,
    failure?: InstallerFailure,
    fault?: "icon" | "mapping",
    destination = installDir,
  ) {
    const running = await startInstall({
      version,
      executable,
      config,
      destination,
      ...(tasks !== undefined
        ? {
            tasks,
          }
        : {}),
      ...(failure !== undefined
        ? {
            failure,
          }
        : {}),
      ...(fault !== undefined
        ? {
            fault,
          }
        : {}),
    });
    await running.finish();
  }
  async function startUninstall(
    failure?: "busy" | "read" | "key-cleanup" | "metadata",
  ) {
    const executable = join(installDir, "unins000.exe");
    if (!(await Bun.file(executable).exists())) {
      throw new Error("Fixture uninstaller is missing.");
    }
    const logPath = join(root, `uninstall-${crypto.randomUUID()}.log`);
    const child = Bun.spawn(
      [
        executable,
        ...silent,
        `/LOG=${logPath}`,
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    /** A deliberately failed uninstall exits non-zero, logs the reason and leaves the payload available. */
    async function expectFailedUninstall(
      code: number,
      expected: NonNullable<typeof failure>,
    ) {
      expect(code).not.toBe(0);
      const failureMessages = {
        busy: "Another setup or uninstall is maintaining this application",
        read: "Could not inspect app association",
        "key-cleanup": "Could not remove app association key",
        metadata: "Could not read installation identity",
      };
      expect(await Bun.file(logPath).text()).toContain(
        failureMessages[expected],
      );
      if (expected === "busy") {
        return; // The deliberately paused competing process still owns it.
      }
      // Failed uninstall must finish natively before the fixture changes ACLs
      // or retries, while leaving the payload and uninstaller available.
      for (let i = 0; i < 200; i++) {
        if (await maintenanceAvailable(mutexes.maintenance)) {
          return;
        }
        await Bun.sleep(50);
      }
      throw new Error("Failed uninstaller did not finish.");
    }
    async function finish() {
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      if (failure) {
        await expectFailedUninstall(code, failure);
        return;
      }
      if (code !== 0) {
        throw new Error(`Uninstaller failed (${code}): ${stdout} ${stderr}`);
      }
      for (let i = 0; i < 200; i++) {
        if (
          !(await Bun.file(executable).exists()) &&
          (await maintenanceAvailable(mutexes.maintenance))
        ) {
          return;
        }
        await Bun.sleep(50);
      }
      throw new Error("Uninstaller did not finish.");
    }
    return {
      child,
      logPath,
      finish,
    };
  }
  async function uninstall(
    failure?: "busy" | "read" | "key-cleanup" | "metadata",
  ) {
    if (!(await Bun.file(join(installDir, "unins000.exe")).exists())) {
      return;
    }
    const running = await startUninstall(failure);
    await running.finish();
  }
  async function cleanup() {
    await uninstall();
    for (const key of [
      associationRoot,
      unexpectedPreviousDataKey,
      `Software\\Classes\\${extension}`,
      `Software\\Classes\\${scheme}`,
      `Software\\Classes\\${fileProgId}`,
      `Software\\Classes\\${urlProgId}`,
      `Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\${extension}`,
    ]) {
      await powershell(
        `$key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey(${quote(key)}); if ($key) { $key.Dispose(); [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree(${quote(key)},$false) }`,
      );
    }
    await powershell(
      `$key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\\RegisteredApplications',$true); if ($key) { try { $key.DeleteValue(${quote(registration)},$false) } finally { $key.Dispose() } }`,
    );
    await rm(root, {
      recursive: true,
      force: true,
    });
  }
  return {
    identifier,
    root,
    extension,
    scheme,
    associationRoot,
    previousDataKey,
    unexpectedPreviousDataKey,
    registration,
    fileProgId,
    urlProgId,
    installDir,
    declarations,
    quote,
    powershell,
    query,
    registryKeyExists,
    write,
    denyValueWrites,
    denyRegistryRights,
    verifyQueryOnlyDenial,
    restoreRegistrationFault,
    install,
    startInstall,
    uninstall,
    startUninstall,
    cleanup,
  };
}

const iscc = process.platform === "win32" ? await findIscc() : undefined;

for (const fault of [
  "icon",
  "mapping",
] as const) {
  test.skipIf(!iscc)(
    `native association ${fault} write failure recovers absent commands and safely uninstalls`,
    async () => {
      if (!iscc) {
        throw new Error("ISCC is required.");
      }
      const fixture = await createNativeAssociationFixture(iscc);
      const {
        extension,
        associationRoot,
        previousDataKey,
        fileProgId,
        installDir,
        declarations,
        query,
        write,
        install,
        restoreRegistrationFault,
        uninstall,
        cleanup,
      } = fixture;
      const config = {
        files: declarations.files,
      };
      const foreignKey = `Software\\Classes\\${extension}\\OpenWithProgids`;
      try {
        await write(`Software\\Classes\\${extension}`, "", "Foreign.File");
        await write(foreignKey, "Foreign.Candidate", "foreign-marker");
        for (const outcome of [
          "retry",
          "uninstall",
          "foreign",
        ] as const) {
          const version = `${fault}-${outcome}`;
          try {
            await install(
              version,
              "New.exe",
              config,
              "fileassociations",
              "write",
              fault,
            );
            expect(
              await query(`${associationRoot}\\PendingCandidates`, fileProgId),
            ).toBe(join(installDir, "New.exe"));
            expect(
              await query(
                `Software\\Classes\\${fileProgId}\\shell\\open\\command`,
              ),
            ).toBe("MISSING");
            if (fault === "icon") {
              // The name really succeeded, and the first DefaultIcon write failed.
              expect(await query(`Software\\Classes\\${fileProgId}`)).toBe(
                "문서",
              );
              expect(
                await query(`Software\\Classes\\${fileProgId}\\DefaultIcon`),
              ).toBe("MISSING");
              expect(
                await query(
                  `${associationRoot}\\Capabilities\\FileAssociations`,
                  extension,
                ),
              ).toBe(fileProgId);
            } else {
              expect(await query(`Software\\Classes\\${fileProgId}`)).toBe(
                "MISSING",
              );
              expect(
                await query(
                  `${associationRoot}\\Capabilities\\FileAssociations`,
                  extension,
                ),
              ).toBe("MISSING");
            }
          } catch (error) {
            console.error(error);
            throw error;
          } finally {
            await restoreRegistrationFault(version, fault);
          }
          if (outcome === "retry") {
            await install(
              `${version}-restored`,
              "New.exe",
              config,
              "fileassociations",
            );
            expect(
              await query(
                `Software\\Classes\\${fileProgId}\\shell\\open\\command`,
              ),
            ).toBe(`"${join(installDir, "New.exe")}" "%1"`);
            expect(
              await query(`${associationRoot}\\PendingCandidates`, fileProgId),
            ).toBe("MISSING");
            expect(
              await query(
                previousDataKey,
                "Inno Setup CodeFile: PendingAssociationOwner",
              ),
            ).toBe("");
          } else if (outcome === "foreign") {
            await write(
              `Software\\Classes\\${fileProgId}\\shell\\open\\command`,
              "",
              '"foreign-replacement.exe" "%1"',
            );
            await install(
              `${version}-collision`,
              "New.exe",
              config,
              "fileassociations",
              "collision",
            );
          }
          await uninstall();
          expect(await query(associationRoot, "Executable")).toBe("MISSING");
          expect(await query(`Software\\Classes\\${extension}`)).toBe(
            "Foreign.File",
          );
          expect(await query(foreignKey, "Foreign.Candidate")).toBe(
            "foreign-marker",
          );
          expect(
            await query(
              `Software\\Classes\\${fileProgId}\\shell\\open\\command`,
            ),
          ).toBe(
            outcome === "foreign"
              ? '"foreign-replacement.exe" "%1"'
              : "MISSING",
          );
          if (outcome !== "foreign") {
            expect(await query(`Software\\Classes\\${fileProgId}`)).toBe(
              "MISSING",
            );
          }
        }
      } catch (error) {
        console.error(error);
        throw error;
      } finally {
        await cleanup();
      }
    },
    120000,
  );
}

test.skipIf(!iscc)(
  "native unreadable foreign commands never inherit partial registration ownership",
  async () => {
    if (!iscc) {
      throw new Error("ISCC is required.");
    }
    const fixture = await createNativeAssociationFixture(iscc);
    const {
      installDir,
      declarations,
      fileProgId,
      associationRoot,
      registration,
      query,
      write,
      registryKeyExists,
      denyRegistryRights,
      verifyQueryOnlyDenial,
      restoreRegistrationFault,
      install,
      uninstall,
      cleanup,
    } = fixture;
    const config = {
      files: declarations.files,
    };
    const candidate = `Software\\Classes\\${fileProgId}`;
    const command = `${candidate}\\shell\\open\\command`;
    const foreignCommand = '"foreign-replacement.exe" "%1"';
    const executable = join(installDir, "New.exe");
    try {
      for (const outcome of [
        "retry",
        "uninstall",
      ] as const) {
        const version = `unreadable-${outcome}`;
        try {
          await install(
            version,
            "New.exe",
            config,
            "fileassociations",
            "write",
            "icon",
          );
        } finally {
          await restoreRegistrationFault(version, "icon");
        }
        expect(
          await query(`${associationRoot}\\PendingCandidates`, fileProgId),
        ).toBe(executable);
        await write(command, "", foreignCommand);
        await write(`${candidate}\\DefaultIcon`, "", "foreign-icon");
        const restore = await denyRegistryRights(command, "QueryValues");
        try {
          await verifyQueryOnlyDenial(command);
          await install(
            `${version}-selected`,
            "New.exe",
            config,
            "fileassociations",
            "read-preflight",
          );
          if (outcome === "retry") {
            await install(
              `${version}-cleanup`,
              "New.exe",
              undefined,
              undefined,
              "read",
            );
          } else {
            await uninstall("read");
          }
          expect(await registryKeyExists(candidate)).toBe(true);
          expect(await query(associationRoot, "Executable")).toBe(executable);
          expect(
            await query(`${associationRoot}\\PendingCandidates`, fileProgId),
          ).toBe(executable);
          expect(
            await query("Software\\RegisteredApplications", registration),
          ).toBe(`${associationRoot}\\Capabilities`);
          expect(await Bun.file(executable).exists()).toBe(true);
          expect(
            await Bun.file(join(installDir, "unins000.exe")).exists(),
          ).toBe(true);
        } finally {
          await restore();
        }
        // Restoring query access reveals that neither failure deleted or replaced foreign data.
        expect(await query(command)).toBe(foreignCommand);
        expect(await query(`${candidate}\\DefaultIcon`)).toBe("foreign-icon");
        if (outcome === "retry") {
          await install(`${version}-restored`, "New.exe", undefined);
        }
        await uninstall();
        expect(await query(associationRoot, "Executable")).toBe("MISSING");
        expect(await query(command)).toBe(foreignCommand);
        expect(await query(`${candidate}\\DefaultIcon`)).toBe("foreign-icon");
        // The next partial-registration scenario starts from a genuinely absent candidate.
        await fixture.powershell(
          `[Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree(${fixture.quote(candidate)},$false)`,
        );
      }
    } finally {
      await cleanup();
    }
  },
  180000,
);

test.skipIf(!iscc)(
  "native partial ProgID deletion retains authenticated cleanup ownership until retry or uninstall",
  async () => {
    if (!iscc) {
      throw new Error("ISCC is required.");
    }
    const fixture = await createNativeAssociationFixture(iscc);
    const {
      installDir,
      declarations,
      fileProgId,
      associationRoot,
      previousDataKey,
      query,
      registryKeyExists,
      denyRegistryRights,
      install,
      uninstall,
      cleanup,
    } = fixture;
    const config = {
      files: declarations.files,
    };
    const candidate = `Software\\Classes\\${fileProgId}`;
    const oldExecutable = join(installDir, "Old.exe");
    const newExecutable = join(installDir, "New.exe");
    try {
      for (const outcome of [
        "retry",
        "uninstall",
      ] as const) {
        await install(
          `partial-delete-${outcome}-old`,
          "Old.exe",
          config,
          "fileassociations",
        );
        expect(
          await query(`${associationRoot}\\PendingCandidates`, fileProgId),
        ).toBe("MISSING");
        const restore = await denyRegistryRights(
          `${candidate}\\DefaultIcon`,
          "Delete",
        );
        try {
          await install(
            `partial-delete-${outcome}-new`,
            "New.exe",
            undefined,
            undefined,
            "key-cleanup",
          );
          // Inno's recursive delete removed the ownership command before its blocked icon child.
          expect(await query(`${candidate}\\shell\\open\\command`)).toBe(
            "MISSING",
          );
          expect(await query(`${candidate}\\DefaultIcon`)).toBe(
            `"${oldExecutable}",0`,
          );
          expect(await registryKeyExists(candidate)).toBe(true);
          expect(
            await query(`${associationRoot}\\PendingCandidates`, fileProgId),
          ).toBe(oldExecutable);
          expect(
            await query(
              previousDataKey,
              "Inno Setup CodeFile: PendingAssociationOwner",
            ),
          ).toBe(oldExecutable);
          if (outcome === "retry") {
            await install(
              `partial-delete-${outcome}-again`,
              "New.exe",
              undefined,
              undefined,
              "key-cleanup",
            );
          } else {
            await uninstall("key-cleanup");
          }
          expect(
            await query(`${associationRoot}\\PendingCandidates`, fileProgId),
          ).toBe(oldExecutable);
          expect(await query(associationRoot, "Executable")).toBe(
            oldExecutable,
          );
          expect(await Bun.file(oldExecutable).exists()).toBe(true);
          expect(await Bun.file(newExecutable).exists()).toBe(true);
        } finally {
          await restore();
        }
        if (outcome === "retry") {
          await install(
            `partial-delete-${outcome}-restored`,
            "New.exe",
            undefined,
          );
          expect(await Bun.file(oldExecutable).exists()).toBe(false);
          expect(
            await query(
              previousDataKey,
              "Inno Setup CodeFile: PendingAssociationOwner",
            ),
          ).toBe("");
        }
        await uninstall();
        expect(await registryKeyExists(candidate)).toBe(false);
        expect(await query(associationRoot, "Executable")).toBe("MISSING");
        expect(await Bun.file(oldExecutable).exists()).toBe(false);
        expect(await Bun.file(newExecutable).exists()).toBe(false);
      }
    } finally {
      await cleanup();
    }
  },
  180000,
);

test.skipIf(!iscc)(
  "native association enumeration denial retains registrations and predecessor payload for recovery",
  async () => {
    if (!iscc) {
      throw new Error("ISCC is required.");
    }
    const fixture = await createNativeAssociationFixture(iscc);
    const {
      installDir,
      declarations,
      fileProgId,
      associationRoot,
      previousDataKey,
      registration,
      query,
      registryKeyExists,
      denyRegistryRights,
      verifyQueryOnlyDenial,
      install,
      uninstall,
      cleanup,
    } = fixture;
    const config = {
      files: declarations.files,
    };
    const mapping = `${associationRoot}\\Capabilities\\FileAssociations`;
    const candidate = `Software\\Classes\\${fileProgId}`;
    const oldExecutable = join(installDir, "Old.exe");
    const newExecutable = join(installDir, "New.exe");
    try {
      for (const outcome of [
        "retry",
        "uninstall",
      ] as const) {
        await install(
          `enumeration-${outcome}-old`,
          "Old.exe",
          config,
          "fileassociations",
        );
        const restore = await denyRegistryRights(mapping, "QueryValues");
        try {
          await verifyQueryOnlyDenial(mapping);
          await install(
            `enumeration-${outcome}-new`,
            "New.exe",
            undefined,
            undefined,
            "read",
          );
          if (outcome === "uninstall") {
            await uninstall("read");
          }
          expect(await query(associationRoot, "Executable")).toBe(
            oldExecutable,
          );
          expect(
            await query("Software\\RegisteredApplications", registration),
          ).toBe(`${associationRoot}\\Capabilities`);
          expect(await registryKeyExists(candidate)).toBe(true);
          expect(await query(`${candidate}\\shell\\open\\command`)).toBe(
            `"${oldExecutable}" "%1"`,
          );
          expect(
            await query(previousDataKey, "Inno Setup CodeFile: ExecutableName"),
          ).toBe("New.exe");
          expect(
            await query(
              previousDataKey,
              "Inno Setup CodeFile: PendingAssociationOwner",
            ),
          ).toBe(oldExecutable);
          expect(await Bun.file(oldExecutable).exists()).toBe(true);
          expect(await Bun.file(newExecutable).exists()).toBe(true);
          expect(
            await Bun.file(join(installDir, "unins000.exe")).exists(),
          ).toBe(true);
        } finally {
          await restore();
        }
        if (outcome === "retry") {
          await install(
            `enumeration-${outcome}-restored`,
            "New.exe",
            undefined,
          );
          expect(await Bun.file(oldExecutable).exists()).toBe(false);
          expect(
            await query(
              previousDataKey,
              "Inno Setup CodeFile: PendingAssociationOwner",
            ),
          ).toBe("");
        }
        await uninstall();
        expect(await registryKeyExists(candidate)).toBe(false);
        expect(await registryKeyExists(associationRoot)).toBe(false);
        expect(
          await query("Software\\RegisteredApplications", registration),
        ).toBe("MISSING");
        expect(await Bun.file(oldExecutable).exists()).toBe(false);
        expect(await Bun.file(newExecutable).exists()).toBe(false);
      }
    } finally {
      await cleanup();
    }
  },
  180000,
);

test.skipIf(!iscc)(
  "native installation identity reads reject denied and malformed metadata before retirement",
  async () => {
    if (!iscc) {
      throw new Error("ISCC is required.");
    }
    const fixture = await createNativeAssociationFixture(iscc);
    const {
      root,
      installDir,
      declarations,
      fileProgId,
      extension,
      associationRoot,
      previousDataKey,
      registration,
      quote,
      powershell,
      query,
      denyValueWrites,
      denyRegistryRights,
      verifyQueryOnlyDenial,
      startInstall,
      install,
      startUninstall,
      uninstall,
      cleanup,
    } = fixture;
    const config = {
      files: declarations.files,
    };
    const oldExecutable = join(installDir, "Old.exe");
    const newExecutable = join(installDir, "New.exe");
    const thirdExecutable = join(installDir, "Third.exe");
    const openWith = `Software\\Classes\\${extension}\\OpenWithProgids`;
    const command = `Software\\Classes\\${fileProgId}\\shell\\open\\command`;
    const identity = [
      [
        "ExecutableName",
        "New.exe",
      ],
      [
        "InstallDir",
        installDir,
      ],
      [
        "PendingAssociationOwner",
        oldExecutable,
      ],
    ] as const;
    const gates: NativeGate[] = [];
    async function assertRecoveryState() {
      expect(await Bun.file(oldExecutable).exists()).toBe(true);
      expect(await Bun.file(newExecutable).exists()).toBe(true);
      expect(await Bun.file(thirdExecutable).exists()).toBe(false);
      expect(await Bun.file(join(installDir, "unins000.exe")).exists()).toBe(
        true,
      );
      expect(await query(associationRoot, "Executable")).toBe(oldExecutable);
      expect(await query(command)).toBe(`"${oldExecutable}" "%1"`);
      expect(
        await query("Software\\RegisteredApplications", registration),
      ).toBe(`${associationRoot}\\Capabilities`);
      for (const [name, value] of identity) {
        expect(
          await query(previousDataKey, `Inno Setup CodeFile: ${name}`),
        ).toBe(value);
      }
    }
    async function denyMetadataWhileGated(
      running: {
        finish(): Promise<void>;
      },
      gate: NativeGate,
    ) {
      let restore: (() => Promise<string>) | undefined;
      try {
        await whileGated(running, gate, async () => {
          restore = await denyRegistryRights(previousDataKey, "QueryValues");
          await verifyQueryOnlyDenial(previousDataKey);
        });
      } finally {
        if (restore) {
          await restore();
        }
      }
    }
    try {
      for (const outcome of [
        "retry",
        "uninstall",
      ] as const) {
        const setupGate = {
          ready: join(root, `identity-${outcome}-setup-ready`),
          release: join(root, `identity-${outcome}-setup-release`),
        };
        const uninstallGate = {
          ready: join(root, `identity-${outcome}-uninstall-ready`),
          release: join(root, `identity-${outcome}-uninstall-release`),
        };
        gates.push(setupGate, uninstallGate);
        await install(
          `identity-${outcome}-old`,
          "Old.exe",
          config,
          "fileassociations",
        );
        const restoreAssociation = await denyValueWrites(openWith);
        try {
          // Retain a real predecessor with current New.exe metadata before the metadata ACL fault.
          const update = await startInstall({
            version: `identity-${outcome}-new`,
            executable: "New.exe",
            config,
            tasks: "fileassociations",
            failure: "cleanup",
            uninstallGate,
          });
          await update.finish();
        } finally {
          await restoreAssociation();
        }
        await assertRecoveryState();
        const restoreMetadata = await denyRegistryRights(
          previousDataKey,
          "QueryValues",
        );
        try {
          await verifyQueryOnlyDenial(previousDataKey);
          // These must abort in initialization, before either caller can read an empty snapshot.
          await install(
            `identity-${outcome}-blocked`,
            "Third.exe",
            undefined,
            undefined,
            "metadata",
          );
          await uninstall("metadata");
          expect(await Bun.file(oldExecutable).exists()).toBe(true);
          expect(await Bun.file(newExecutable).exists()).toBe(true);
          expect(await Bun.file(thirdExecutable).exists()).toBe(false);
          expect(await query(associationRoot, "Executable")).toBe(
            oldExecutable,
          );
          expect(await query(command)).toBe(`"${oldExecutable}" "%1"`);
        } finally {
          await restoreMetadata();
        }
        await assertRecoveryState();
        if (outcome === "retry") {
          // A present non-string value is also a failed identity read, not an absent field.
          // Exercise each of the three fields through both setup and uninstall initialization.
          for (const [name, value] of identity) {
            const field = `Inno Setup CodeFile: ${name}`;
            await powershell(
              `$key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey(${quote(previousDataKey)},$true); try { $key.SetValue(${quote(field)},0,[Microsoft.Win32.RegistryValueKind]::DWord) } finally { $key.Dispose() }`,
            );
            try {
              const blocked = await startInstall({
                version: `identity-malformed-${name}`,
                executable: "Third.exe",
                config: undefined,
                failure: "metadata",
              });
              await blocked.finish();
              expect(await Bun.file(blocked.logPath).text()).toContain(
                `Could not read installation identity: ${name}`,
              );
              const removal = await startUninstall("metadata");
              await removal.finish();
              expect(await Bun.file(removal.logPath).text()).toContain(
                `Could not read installation identity: ${name}`,
              );
              expect(await Bun.file(oldExecutable).exists()).toBe(true);
              expect(await Bun.file(newExecutable).exists()).toBe(true);
              expect(await Bun.file(thirdExecutable).exists()).toBe(false);
            } finally {
              await fixture.write(previousDataKey, field, value);
            }
          }
          await assertRecoveryState();
        }
        // Capture succeeded in these processes. Denial introduced at the real callbacks
        // must still abort the shared validation reader before payload or metadata retirement.
        const delayed = await startInstall({
          version: `identity-${outcome}-delayed`,
          executable: "Third.exe",
          config: undefined,
          failure: "metadata-preflight",
          setupGate,
        });
        await denyMetadataWhileGated(delayed, setupGate);
        await assertRecoveryState();
        const removal = await startUninstall("metadata");
        await denyMetadataWhileGated(removal, uninstallGate);
        await assertRecoveryState();
        if (outcome === "retry") {
          await install(`identity-${outcome}-recovered`, "New.exe", undefined);
          expect(await Bun.file(oldExecutable).exists()).toBe(false);
          expect(
            await query(
              previousDataKey,
              "Inno Setup CodeFile: PendingAssociationOwner",
            ),
          ).toBe("");
        }
        await uninstall();
        expect(await Bun.file(oldExecutable).exists()).toBe(false);
        expect(await Bun.file(newExecutable).exists()).toBe(false);
        expect(await query(command)).toBe("MISSING");
        expect(await query(associationRoot, "Executable")).toBe("MISSING");
        expect(
          await query("Software\\RegisteredApplications", registration),
        ).toBe("MISSING");
        expect(
          await query(previousDataKey, "Inno Setup CodeFile: ExecutableName"),
        ).toBe("MISSING");
      }
    } finally {
      for (const gate of gates) {
        await Bun.write(gate.release, "release");
      }
      await cleanup();
    }
  },
  240000,
);

test.skipIf(!iscc)(
  "native renamed association cleanup preserves its trusted owner across failures, retry and uninstall",
  async () => {
    if (!iscc) {
      throw new Error("ISCC is required.");
    }
    const fixture = await createNativeAssociationFixture(iscc);
    const {
      extension,
      associationRoot,
      previousDataKey,
      unexpectedPreviousDataKey,
      fileProgId,
      urlProgId,
      installDir,
      declarations,
      query,
      registryKeyExists,
      write,
      denyValueWrites,
      install,
      uninstall,
      cleanup,
    } = fixture;
    const openWithKey = `Software\\Classes\\${extension}\\OpenWithProgids`;
    try {
      await write(`Software\\Classes\\${extension}`, "", "Foreign.File");
      await write(openWithKey, "Foreign.Candidate", "foreign-marker");
      for (const outcome of [
        "retry",
        "uninstall",
      ] as const) {
        await install(
          `old-${outcome}`,
          "Old.exe",
          declarations,
          "fileassociations,urlschemes",
        );
        expect(await registryKeyExists(previousDataKey)).toBe(true);
        expect(await registryKeyExists(unexpectedPreviousDataKey)).toBe(false);
        const restore = await denyValueWrites(openWithKey);
        try {
          for (const attempt of [
            "first",
            "again",
          ] as const) {
            await install(
              `new-${outcome}-${attempt}`,
              "New.exe",
              declarations,
              "fileassociations,urlschemes",
              "cleanup",
            );
            expect(await query(associationRoot, "Executable")).toBe(
              join(installDir, "Old.exe"),
            );
            expect(
              await query(
                `Software\\Classes\\${fileProgId}\\shell\\open\\command`,
              ),
            ).toBe(`"${join(installDir, "Old.exe")}" "%1"`);
            expect(
              await query(
                previousDataKey,
                "Inno Setup CodeFile: ExecutableName",
              ),
            ).toBe("New.exe");
            expect(
              await query(
                previousDataKey,
                "Inno Setup CodeFile: PendingAssociationOwner",
              ),
            ).toBe(join(installDir, "Old.exe"));
            expect(await registryKeyExists(unexpectedPreviousDataKey)).toBe(
              false,
            );
            expect(await Bun.file(join(installDir, "Old.exe")).exists()).toBe(
              true,
            );
            expect(await Bun.file(join(installDir, "New.exe")).exists()).toBe(
              true,
            );
          }
        } finally {
          await restore();
        }
        if (outcome === "retry") {
          await install(
            `new-${outcome}-restored`,
            "New.exe",
            declarations,
            "fileassociations,urlschemes",
          );
          expect(
            await query(
              `Software\\Classes\\${fileProgId}\\shell\\open\\command`,
            ),
          ).toBe(`"${join(installDir, "New.exe")}" "%1"`);
          expect(
            await query(
              previousDataKey,
              "Inno Setup CodeFile: PendingAssociationOwner",
            ),
          ).toBe("");
          expect(await registryKeyExists(unexpectedPreviousDataKey)).toBe(
            false,
          );
          expect(await Bun.file(join(installDir, "Old.exe")).exists()).toBe(
            false,
          );
        } else {
          // The new uninstaller must clean the trusted old snapshot, while a
          // foreign command change still overrides its pending-owner record.
          await write(
            `Software\\Classes\\${urlProgId}\\shell\\open\\command`,
            "",
            '"foreign-replacement.exe" "%1"',
          );
        }
        await uninstall();
        expect(await Bun.file(join(installDir, "Old.exe")).exists()).toBe(
          false,
        );
        expect(await Bun.file(join(installDir, "New.exe")).exists()).toBe(
          false,
        );
        expect(await query(associationRoot, "Executable")).toBe("MISSING");
        expect(
          await query(`Software\\Classes\\${fileProgId}\\shell\\open\\command`),
        ).toBe("MISSING");
        expect(await query(openWithKey, fileProgId)).toBe("MISSING");
        expect(
          await query(`Software\\Classes\\${urlProgId}\\shell\\open\\command`),
        ).toBe(
          outcome === "uninstall"
            ? '"foreign-replacement.exe" "%1"'
            : "MISSING",
        );
        expect(await query(`Software\\Classes\\${extension}`)).toBe(
          "Foreign.File",
        );
        expect(await query(openWithKey, "Foreign.Candidate")).toBe(
          "foreign-marker",
        );
      }
    } catch (error) {
      console.error(error);
      throw error;
    } finally {
      await cleanup();
    }
  },
  120000,
);

test.skipIf(!iscc)(
  "native payload cleanup retains its predecessor after reconciliation until retry or uninstall",
  async () => {
    if (!iscc) {
      throw new Error("ISCC is required.");
    }
    const fixture = await createNativeAssociationFixture(iscc);
    const {
      installDir,
      declarations,
      associationRoot,
      previousDataKey,
      fileProgId,
      query,
      install,
      uninstall,
      cleanup,
    } = fixture;
    try {
      for (const outcome of [
        "retry",
        "uninstall",
      ] as const) {
        await install(
          `old-payload-${outcome}`,
          "Old.exe",
          declarations,
          "fileassociations,urlschemes",
        );
        const oldExecutable = join(installDir, "Old.exe");
        const release = await preventFileDeletion(oldExecutable);
        try {
          for (const attempt of [
            "first",
            "again",
          ] as const) {
            await install(
              `new-payload-${outcome}-${attempt}`,
              "New.exe",
              declarations,
              "fileassociations,urlschemes",
              "payload-cleanup",
            );
            // Registry reconciliation really completed before the native delete failed.
            expect(await query(associationRoot, "Executable")).toBe(
              join(installDir, "New.exe"),
            );
            expect(
              await query(
                `Software\\Classes\\${fileProgId}\\shell\\open\\command`,
              ),
            ).toBe(`"${join(installDir, "New.exe")}" "%1"`);
            expect(
              await query(
                previousDataKey,
                "Inno Setup CodeFile: ExecutableName",
              ),
            ).toBe("New.exe");
            expect(
              await query(
                previousDataKey,
                "Inno Setup CodeFile: PendingAssociationOwner",
              ),
            ).toBe(oldExecutable);
            expect(await Bun.file(oldExecutable).exists()).toBe(true);
          }
        } finally {
          release();
        }
        if (outcome === "retry") {
          await install(
            "new-payload-restored",
            "New.exe",
            declarations,
            "fileassociations,urlschemes",
          );
          expect(
            await query(
              previousDataKey,
              "Inno Setup CodeFile: PendingAssociationOwner",
            ),
          ).toBe("");
          expect(await Bun.file(oldExecutable).exists()).toBe(false);
        }
        await uninstall();
        expect(await Bun.file(oldExecutable).exists()).toBe(false);
        expect(await Bun.file(join(installDir, "New.exe")).exists()).toBe(
          false,
        );
        expect(await query(associationRoot, "Executable")).toBe("MISSING");
      }
    } finally {
      await cleanup();
    }
  },
  120000,
);

test.skipIf(!iscc)(
  "native unresolved predecessor rejects a third executable before installing payload",
  async () => {
    if (!iscc) {
      throw new Error("ISCC is required.");
    }
    const fixture = await createNativeAssociationFixture(iscc);
    const {
      installDir,
      declarations,
      associationRoot,
      previousDataKey,
      fileProgId,
      query,
      install,
      uninstall,
      cleanup,
    } = fixture;
    const oldExecutable = join(installDir, "Old.exe");
    const newExecutable = join(installDir, "New.exe");
    const thirdExecutable = join(installDir, "Third.exe");
    async function rejectThird(version: string) {
      await install(
        version,
        "Third.exe",
        declarations,
        "fileassociations,urlschemes",
        "pending-owner",
      );
      expect(await Bun.file(thirdExecutable).exists()).toBe(false);
      expect(await Bun.file(oldExecutable).exists()).toBe(true);
      expect(await Bun.file(newExecutable).exists()).toBe(true);
      expect(await query(associationRoot, "Executable")).toBe(newExecutable);
      expect(
        await query(`Software\\Classes\\${fileProgId}\\shell\\open\\command`),
      ).toBe(`"${newExecutable}" "%1"`);
      expect(
        await query(previousDataKey, "Inno Setup CodeFile: ExecutableName"),
      ).toBe("New.exe");
      expect(
        await query(
          previousDataKey,
          "Inno Setup CodeFile: PendingAssociationOwner",
        ),
      ).toBe(oldExecutable);
    }
    try {
      for (const outcome of [
        "retry",
        "uninstall",
      ] as const) {
        await install(
          `three-old-${outcome}`,
          "Old.exe",
          declarations,
          "fileassociations,urlschemes",
        );
        const release = await preventFileDeletion(oldExecutable);
        try {
          await install(
            `three-new-${outcome}`,
            "New.exe",
            declarations,
            "fileassociations,urlschemes",
            "payload-cleanup",
          );
          await rejectThird(`three-third-${outcome}-locked`);
        } finally {
          release();
        }
        // Releasing the lock alone does not reconcile persisted ownership.
        await rejectThird(`three-third-${outcome}-released`);
        const otherDirectory = join(dirname(installDir), `other-${outcome}`);
        await install(
          `three-directory-${outcome}`,
          "New.exe",
          declarations,
          "fileassociations,urlschemes",
          "pending-owner",
          undefined,
          otherDirectory,
        );
        expect(await Bun.file(join(otherDirectory, "New.exe")).exists()).toBe(
          false,
        );
        expect(
          await query(
            previousDataKey,
            "Inno Setup CodeFile: PendingAssociationOwner",
          ),
        ).toBe(oldExecutable);
        if (outcome === "retry") {
          await install(
            "three-new-recovered",
            "New.exe",
            declarations,
            "fileassociations,urlschemes",
          );
          expect(await Bun.file(oldExecutable).exists()).toBe(false);
          expect(
            await query(
              previousDataKey,
              "Inno Setup CodeFile: PendingAssociationOwner",
            ),
          ).toBe("");
          await install(
            "three-third-allowed",
            "Third.exe",
            declarations,
            "fileassociations,urlschemes",
          );
          expect(await Bun.file(newExecutable).exists()).toBe(false);
          expect(await Bun.file(thirdExecutable).exists()).toBe(true);
          expect(await query(associationRoot, "Executable")).toBe(
            thirdExecutable,
          );
        }
        await uninstall();
        expect(await Bun.file(oldExecutable).exists()).toBe(false);
        expect(await Bun.file(newExecutable).exists()).toBe(false);
        expect(await Bun.file(thirdExecutable).exists()).toBe(false);
        expect(await query(associationRoot, "Executable")).toBe("MISSING");
      }
    } finally {
      await cleanup();
    }
  },
  120000,
);

test.skipIf(!iscc)(
  "native maintenance ownership serializes delayed setup and uninstall through completion",
  async () => {
    if (!iscc) {
      throw new Error("ISCC is required.");
    }
    const fixture = await createNativeAssociationFixture(iscc);
    const {
      root,
      installDir,
      declarations,
      associationRoot,
      previousDataKey,
      startInstall,
      install,
      startUninstall,
      uninstall,
      query,
      cleanup,
    } = fixture;
    const setupGate = {
      ready: join(root, "setup-ready"),
      release: join(root, "setup-release"),
    };
    const uninstallGate = {
      ready: join(root, "uninstall-ready"),
      release: join(root, "uninstall-release"),
    };
    const newExecutable = join(installDir, "New.exe");
    try {
      await install(
        "serial-initial",
        "New.exe",
        declarations,
        "fileassociations,urlschemes",
      );
      const setup = await startInstall({
        version: "serial-delayed",
        executable: "New.exe",
        config: declarations,
        tasks: "fileassociations,urlschemes",
        setupGate,
        uninstallGate,
      });
      await whileGated(setup, setupGate, async () => {
        // There is no distinct predecessor: this must be blocked by ownership, not the three-name guard.
        await install(
          "serial-other",
          "Other.exe",
          declarations,
          "fileassociations,urlschemes",
          "busy",
        );
        await uninstall("busy");
        expect(await Bun.file(join(installDir, "Other.exe")).exists()).toBe(
          false,
        );
        expect(await Bun.file(newExecutable).exists()).toBe(true);
        expect(await query(associationRoot, "Executable")).toBe(newExecutable);
        expect(
          await query(previousDataKey, "Inno Setup CodeFile: ExecutableName"),
        ).toBe("New.exe");
      });
      const removal = await startUninstall();
      await whileGated(removal, uninstallGate, async () => {
        await install(
          "serial-during-uninstall",
          "Third.exe",
          declarations,
          "fileassociations,urlschemes",
          "busy",
        );
        expect(await Bun.file(join(installDir, "Third.exe")).exists()).toBe(
          false,
        );
        expect(await Bun.file(newExecutable).exists()).toBe(true);
        expect(await query(associationRoot, "Executable")).toBe(newExecutable);
      });
      expect(await Bun.file(newExecutable).exists()).toBe(false);
      expect(await query(associationRoot, "Executable")).toBe("MISSING");
      await install(
        "serial-after-exit",
        "Third.exe",
        declarations,
        "fileassociations,urlschemes",
      );
      expect(await Bun.file(join(installDir, "Third.exe")).exists()).toBe(true);
      await uninstall();
    } finally {
      await Bun.write(setupGate.release, "release");
      await Bun.write(uninstallGate.release, "release");
      await cleanup();
    }
  },
  180000,
);

test.skipIf(!iscc)(
  "native delayed wizard rejects live pending changes from non-cooperating legacy setups",
  async () => {
    if (!iscc) {
      throw new Error("ISCC is required.");
    }
    const fixture = await createNativeAssociationFixture(iscc);
    const {
      root,
      installDir,
      declarations,
      associationRoot,
      previousDataKey,
      fileProgId,
      startInstall,
      install,
      uninstall,
      query,
      cleanup,
    } = fixture;
    const gate = {
      ready: join(root, "legacy-ready"),
      release: join(root, "legacy-release"),
    };
    const oldExecutable = join(installDir, "Old.exe");
    const newExecutable = join(installDir, "New.exe");
    try {
      await install(
        "stale-initial",
        "New.exe",
        declarations,
        "fileassociations,urlschemes",
      );
      const delayed = await startInstall({
        version: "stale-third",
        executable: "Third.exe",
        config: declarations,
        tasks: "fileassociations,urlschemes",
        failure: "stale",
        setupGate: gate,
      });
      await whileGated(delayed, gate, async () => {
        const old = await startInstall({
          version: "legacy-old",
          executable: "Old.exe",
          config: declarations,
          tasks: "fileassociations,urlschemes",
          legacySetup: true,
        });
        await old.finish();
        const release = await preventFileDeletion(oldExecutable);
        try {
          const replacement = await startInstall({
            version: "legacy-new",
            executable: "New.exe",
            config: declarations,
            tasks: "fileassociations,urlschemes",
            failure: "payload-cleanup",
            legacySetup: true,
          });
          await replacement.finish();
        } finally {
          release();
        }
        // The current identity equals the delayed wizard's initial identity;
        // only its pending predecessor differs. Comparing current names alone is insufficient.
        expect(
          await query(previousDataKey, "Inno Setup CodeFile: ExecutableName"),
        ).toBe("New.exe");
        expect(
          await query(
            previousDataKey,
            "Inno Setup CodeFile: PendingAssociationOwner",
          ),
        ).toBe(oldExecutable);
      });
      expect(await Bun.file(join(installDir, "Third.exe")).exists()).toBe(
        false,
      );
      expect(await Bun.file(oldExecutable).exists()).toBe(true);
      expect(await Bun.file(newExecutable).exists()).toBe(true);
      expect(await query(associationRoot, "Executable")).toBe(newExecutable);
      expect(
        await query(`Software\\Classes\\${fileProgId}\\shell\\open\\command`),
      ).toBe(`"${newExecutable}" "%1"`);
      expect(
        await query(
          previousDataKey,
          "Inno Setup CodeFile: PendingAssociationOwner",
        ),
      ).toBe(oldExecutable);
      await install(
        "stale-recovered",
        "New.exe",
        declarations,
        "fileassociations,urlschemes",
      );
      expect(await Bun.file(oldExecutable).exists()).toBe(false);
      expect(
        await query(
          previousDataKey,
          "Inno Setup CodeFile: PendingAssociationOwner",
        ),
      ).toBe("");
      await uninstall();
    } finally {
      await Bun.write(gate.release, "release");
      await cleanup();
    }
  },
  180000,
);

test.skipIf(!iscc)(
  "native uninstall preserves predecessor paths outside its directory or through a junction",
  async () => {
    if (!iscc) {
      throw new Error("ISCC is required.");
    }
    for (const protection of [
      "other-directory",
      "junction",
    ] as const) {
      const fixture = await createNativeAssociationFixture(iscc);
      const {
        installDir,
        declarations,
        previousDataKey,
        query,
        write,
        install,
        uninstall,
        cleanup,
      } = fixture;
      try {
        await install(
          "old-protected",
          "Old.exe",
          declarations,
          "fileassociations,urlschemes",
        );
        const oldExecutable = join(installDir, "Old.exe");
        const release = await preventFileDeletion(oldExecutable);
        try {
          await install(
            "new-protected",
            "New.exe",
            declarations,
            "fileassociations,urlschemes",
            "payload-cleanup",
          );
          expect(
            await query(
              previousDataKey,
              "Inno Setup CodeFile: PendingAssociationOwner",
            ),
          ).toBe(oldExecutable);
        } finally {
          release();
        }
        let protectedExecutable: string;
        if (protection === "other-directory") {
          protectedExecutable = join(dirname(installDir), "foreign", "Old.exe");
          await Bun.write(protectedExecutable, "foreign payload");
          await write(
            previousDataKey,
            "Inno Setup CodeFile: PendingAssociationOwner",
            protectedExecutable,
          );
        } else {
          const redirectedDir = join(dirname(installDir), "redirected");
          await rename(installDir, redirectedDir);
          await symlink(redirectedDir, installDir, "junction");
          protectedExecutable = join(redirectedDir, "Old.exe");
        }
        await uninstall();
        expect(await Bun.file(protectedExecutable).text()).toBe(
          protection === "other-directory"
            ? "foreign payload"
            : "installer payload fixture",
        );
      } finally {
        await cleanup();
      }
    }
  },
  120000,
);

test.skipIf(!iscc)(
  "native installer preserves opt-in candidates and defaults, preflights collisions and reports registry failures",
  async () => {
    if (!iscc) {
      throw new Error("ISCC is required.");
    }
    const {
      extension,
      scheme,
      associationRoot,
      registration,
      fileProgId,
      urlProgId,
      installDir,
      declarations,
      quote,
      powershell,
      query,
      write,
      install,
      uninstall,
      cleanup,
    } = await createNativeAssociationFixture(iscc);
    try {
      // The fixtures are random isolated extensions and schemes. Existing
      // defaults and a synthetic UserChoice record must remain byte-for-byte.
      await write(`Software\\Classes\\${extension}`, "", "Foreign.File");
      await write(
        `Software\\Classes\\${scheme}\\shell\\open\\command`,
        "",
        '"foreign.exe" "%1"',
      );
      await write(
        `Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\${extension}\\UserChoice`,
        "ProgId",
        "Foreign.File",
      );
      await install("disabled", "앱.exe", declarations);
      expect(await query(associationRoot, "Executable")).toBe("MISSING");
      await install(
        "enabled",
        "앱.exe",
        declarations,
        "fileassociations,urlschemes",
      );
      expect(
        await query(`Software\\Classes\\${fileProgId}\\shell\\open\\command`),
      ).toBe(`"${join(installDir, "앱.exe")}" "%1"`);
      expect(await query(`Software\\Classes\\${fileProgId}`)).toBe("문서");
      expect(await query(`Software\\Classes\\${fileProgId}\\DefaultIcon`)).toBe(
        `"${join(installDir, "앱.exe")}",0`,
      );
      expect(
        await query(`Software\\Classes\\${fileProgId}`, "Content Type"),
      ).toBe("application/x-test");
      expect(
        await query(
          `Software\\Classes\\${extension}\\OpenWithProgids`,
          fileProgId,
        ),
      ).toBe("");
      expect(
        await query(
          `${associationRoot}\\Capabilities\\UrlAssociations`,
          scheme,
        ),
      ).toBe(urlProgId);
      expect(
        await query(`Software\\Classes\\${urlProgId}`, "URL Protocol"),
      ).toBe("");
      expect(
        await query(`Software\\Classes\\${urlProgId}\\shell\\open\\command`),
      ).toBe(`"${join(installDir, "앱.exe")}" "%1"`);
      expect(
        await query("Software\\RegisteredApplications", registration),
      ).toBe(`${associationRoot}\\Capabilities`);
      // A selected ProgID collision must fail before payload installation or
      // deleting the healthy file candidate from the prior snapshot.
      await write(
        `Software\\Classes\\${urlProgId}\\shell\\open\\command`,
        "",
        '"foreign-collision.exe" "%1"',
      );
      await install(
        "collision",
        "충돌 앱.exe",
        declarations,
        "fileassociations,urlschemes",
        "collision",
      );
      expect(
        await query(`Software\\Classes\\${fileProgId}\\shell\\open\\command`),
      ).toBe(`"${join(installDir, "앱.exe")}" "%1"`);
      expect(
        await query(`Software\\Classes\\${urlProgId}\\shell\\open\\command`),
      ).toBe('"foreign-collision.exe" "%1"');
      expect(await query(associationRoot, "Executable")).toBe(
        join(installDir, "앱.exe"),
      );
      expect(await Bun.file(join(installDir, "충돌 앱.exe")).exists()).toBe(
        false,
      );
      expect(await Bun.file(join(installDir, "앱.exe")).exists()).toBe(true);
      await write(
        `Software\\Classes\\${urlProgId}\\shell\\open\\command`,
        "",
        `"${join(installDir, "앱.exe")}" "%1"`,
      );
      await install("renamed", "새 앱.exe", declarations);
      expect(
        await query(`Software\\Classes\\${fileProgId}\\shell\\open\\command`),
      ).toBe(`"${join(installDir, "새 앱.exe")}" "%1"`);
      // A declaration removed from the next snapshot is cleaned without needing
      // the old uninstall log (the existing policy overwrites that log).
      await install("file-only", "새 앱.exe", {
        files: declarations.files,
      });
      expect(
        await query(`Software\\Classes\\${urlProgId}\\shell\\open\\command`),
      ).toBe("MISSING");
      await install("deselected", "새 앱.exe", declarations, "");
      expect(await query(associationRoot, "Executable")).toBe("MISSING");
      // Deny writes only to this random fixture's OpenWith key. The earlier
      // ProgID writes succeed, exercising ssPostInstall failure exit handling.
      const deniedKey = `Software\\Classes\\${extension}\\OpenWithProgids`;
      await write(deniedKey, "Foreign.Candidate", "foreign-marker");
      // Explicit WRITE_DAC rights are required to set and restore this fixture ACL.
      // ReadWriteSubTree marks the .NET handle writable without requesting denied SetValue.
      const descriptor = await powershell(
        `$key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey(${quote(deniedKey)},[Microsoft.Win32.RegistryKeyPermissionCheck]::ReadWriteSubTree,[System.Security.AccessControl.RegistryRights]::ReadPermissions -bor [System.Security.AccessControl.RegistryRights]::ChangePermissions); try { $acl=$key.GetAccessControl([System.Security.AccessControl.AccessControlSections]::Access); $acl.GetSecurityDescriptorSddlForm([System.Security.AccessControl.AccessControlSections]::Access); $rule=[System.Security.AccessControl.RegistryAccessRule]::new([System.Security.Principal.WindowsIdentity]::GetCurrent().User,[System.Security.AccessControl.RegistryRights]::SetValue,[System.Security.AccessControl.AccessControlType]::Deny); $acl.AddAccessRule($rule); $key.SetAccessControl($acl) } finally { $key.Dispose() }`,
      );
      try {
        await install(
          "write-denied",
          "새 앱.exe",
          {
            files: declarations.files,
          },
          "fileassociations",
          "write",
        );
        expect(await query(deniedKey, "Foreign.Candidate")).toBe(
          "foreign-marker",
        );
        expect(await query(`Software\\Classes\\${extension}`)).toBe(
          "Foreign.File",
        );
        expect(
          await query(`Software\\Classes\\${fileProgId}\\shell\\open\\command`),
        ).toBe(`"${join(installDir, "새 앱.exe")}" "%1"`);
        expect(await query(deniedKey, fileProgId)).toBe("MISSING");
      } finally {
        await powershell(
          `$key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey(${quote(deniedKey)},[Microsoft.Win32.RegistryKeyPermissionCheck]::ReadWriteSubTree,[System.Security.AccessControl.RegistryRights]::ChangePermissions); try { $acl=[System.Security.AccessControl.RegistrySecurity]::new(); $acl.SetSecurityDescriptorSddlForm(${quote(descriptor)},[System.Security.AccessControl.AccessControlSections]::Access); $key.SetAccessControl($acl) } finally { $key.Dispose() }`,
        );
      }
      await uninstall();
      expect(await query(deniedKey, "Foreign.Candidate")).toBe(
        "foreign-marker",
      );
      await install(
        "reenabled",
        "새 앱.exe",
        declarations,
        "fileassociations,urlschemes",
      );
      await uninstall();
      expect(await query(associationRoot, "Executable")).toBe("MISSING");
      expect(
        await query("Software\\RegisteredApplications", registration),
      ).toBe("MISSING");
      expect(
        await query(`Software\\Classes\\${fileProgId}\\shell\\open\\command`),
      ).toBe("MISSING");
      expect(
        await query(`Software\\Classes\\${urlProgId}\\shell\\open\\command`),
      ).toBe("MISSING");
      expect(await query(`Software\\Classes\\${extension}`)).toBe(
        "Foreign.File",
      );
      expect(
        await query(`Software\\Classes\\${scheme}\\shell\\open\\command`),
      ).toBe('"foreign.exe" "%1"');
      expect(
        await query(
          `Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\${extension}\\UserChoice`,
          "ProgId",
        ),
      ).toBe("Foreign.File");
      // An installer with no new association declaration must still retire
      // the owned snapshot. It must not take the empty-work early return.
      await install(
        "no-config-enabled",
        "새 앱.exe",
        declarations,
        "fileassociations,urlschemes",
      );
      await install("no-config-retired", "새 앱.exe", undefined);
      expect(await query(associationRoot, "Executable")).toBe("MISSING");
      expect(
        await query(`Software\\Classes\\${fileProgId}\\shell\\open\\command`),
      ).toBe("MISSING");
      expect(
        await query(`Software\\Classes\\${urlProgId}\\shell\\open\\command`),
      ).toBe("MISSING");
      expect(
        await query("Software\\RegisteredApplications", registration),
      ).toBe("MISSING");
      await uninstall();
      await install(
        "foreign-command",
        "앱.exe",
        declarations,
        "fileassociations,urlschemes",
      );
      await write(
        `Software\\Classes\\${fileProgId}\\shell\\open\\command`,
        "",
        '"changed.exe" "%1"',
      );
      await uninstall();
      expect(
        await query(`Software\\Classes\\${fileProgId}\\shell\\open\\command`),
      ).toBe('"changed.exe" "%1"');
      expect(
        await query(
          `Software\\Classes\\${extension}\\OpenWithProgids`,
          fileProgId,
        ),
      ).toBe("");
    } catch (error) {
      // Retain the actual assertion or installer failure if fixture cleanup also fails.
      console.error(error);
      throw error;
    } finally {
      await cleanup();
    }
  },
  120000,
);

/** Remove the Inno uninstall record a relocated fixture leaves, since cleanup only uninstalls the default folder. */
async function removeInstallRecord(
  fixture: Awaited<ReturnType<typeof createNativeAssociationFixture>>,
) {
  const { powershell, quote, previousDataKey } = fixture;
  await powershell(
    `$key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey(${quote(previousDataKey)}); if ($key) { $key.Dispose(); [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree(${quote(previousDataKey)},$false) }`,
  );
}

const relocationPayload = [
  "data\\sub\\리소스.bin",
  "data\\config.json",
];

test.skipIf(!iscc)(
  "native installer moves to another folder, keeps registrations on the new executable and removes only shipped files",
  async () => {
    if (!iscc) {
      throw new Error("ISCC is required.");
    }
    const fixture = await createNativeAssociationFixture(iscc);
    const {
      root,
      installDir,
      declarations,
      associationRoot,
      previousDataKey,
      fileProgId,
      urlProgId,
      startInstall,
      query,
      cleanup,
    } = fixture;
    const moved = join(root, "새 설치 폴더");
    const oldExecutable = join(installDir, "앱.exe");
    const newExecutable = join(moved, "앱.exe");
    try {
      const first = await startInstall({
        version: "relocate-first",
        executable: "앱.exe",
        config: declarations,
        tasks: "fileassociations,urlschemes",
        payloadFiles: relocationPayload,
      });
      await first.finish();
      const userFile = join(installDir, "data", "user-notes.txt");
      await Bun.write(userFile, "user data");
      const second = await startInstall({
        version: "relocate-second",
        executable: "앱.exe",
        config: declarations,
        tasks: "fileassociations,urlschemes",
        destination: moved,
        payloadFiles: relocationPayload,
      });
      await second.finish();
      // The record, the associations and the new files all name the new folder.
      expect(await query(previousDataKey, "Inno Setup: App Path")).toBe(moved);
      expect(await query(associationRoot, "Executable")).toBe(newExecutable);
      for (const progId of [
        fileProgId,
        urlProgId,
      ]) {
        expect(
          await query(`Software\\Classes\\${progId}\\shell\\open\\command`),
        ).toBe(`"${newExecutable}" "%1"`);
      }
      expect(await Bun.file(newExecutable).exists()).toBe(true);
      expect(await Bun.file(join(moved, "data", "config.json")).exists()).toBe(
        true,
      );
      expect(await Bun.file(join(moved, "unins000.exe")).exists()).toBe(true);
      // The old folder loses the executable, uninstaller and shipped files only.
      expect(await Bun.file(oldExecutable).exists()).toBe(false);
      expect(await Bun.file(join(installDir, "unins000.exe")).exists()).toBe(
        false,
      );
      expect(await Bun.file(join(installDir, "unins000.dat")).exists()).toBe(
        false,
      );
      expect(
        await Bun.file(join(installDir, "data", "config.json")).exists(),
      ).toBe(false);
      expect(
        await Bun.file(join(installDir, "data", "sub", "리소스.bin")).exists(),
      ).toBe(false);
      expect(await Bun.file(userFile).text()).toBe("user data");
      expect(
        await query(
          previousDataKey,
          "Inno Setup CodeFile: PendingAssociationOwner",
        ),
      ).toBe("");
    } finally {
      await removeInstallRecord(fixture);
      await cleanup();
    }
  },
  deadline("packagedAudit"),
);

test.skipIf(!iscc)(
  "native relocation does not enable associations the earlier installation did not select",
  async () => {
    if (!iscc) {
      throw new Error("ISCC is required.");
    }
    const fixture = await createNativeAssociationFixture(iscc);
    const {
      root,
      installDir,
      declarations,
      associationRoot,
      fileProgId,
      startInstall,
      query,
      cleanup,
    } = fixture;
    const moved = join(root, "moved");
    try {
      await (
        await startInstall({
          version: "optout-first",
          executable: "앱.exe",
          config: declarations,
          tasks: "",
          payloadFiles: relocationPayload,
        })
      ).finish();
      await (
        await startInstall({
          version: "optout-second",
          executable: "앱.exe",
          config: declarations,
          tasks: "",
          destination: moved,
          payloadFiles: relocationPayload,
        })
      ).finish();
      expect(await query(associationRoot, "Executable")).toBe("MISSING");
      expect(
        await query(`Software\\Classes\\${fileProgId}\\shell\\open\\command`),
      ).toBe("MISSING");
      expect(await Bun.file(join(installDir, "앱.exe")).exists()).toBe(false);
      expect(await Bun.file(join(moved, "앱.exe")).exists()).toBe(true);
    } finally {
      await removeInstallRecord(fixture);
      await cleanup();
    }
  },
  deadline("packagedAudit"),
);

test.skipIf(!iscc)(
  "native relocation keeps the old folder when the new folder is inside it or the old record is unrelated",
  async () => {
    if (!iscc) {
      throw new Error("ISCC is required.");
    }
    const fixture = await createNativeAssociationFixture(iscc);
    const {
      root,
      installDir,
      declarations,
      previousDataKey,
      startInstall,
      powershell,
      quote,
      cleanup,
    } = fixture;
    try {
      await (
        await startInstall({
          version: "nested-first",
          executable: "앱.exe",
          config: declarations,
          tasks: "",
          payloadFiles: relocationPayload,
        })
      ).finish();
      const nested = join(installDir, "nested");
      await (
        await startInstall({
          version: "nested-second",
          executable: "앱.exe",
          config: declarations,
          tasks: "",
          destination: nested,
          payloadFiles: relocationPayload,
        })
      ).finish();
      expect(await Bun.file(join(installDir, "앱.exe")).exists()).toBe(true);
      expect(await Bun.file(join(nested, "앱.exe")).exists()).toBe(true);
      // An Inno record that disagrees with the app's own record is not trusted for the uninstaller.
      const elsewhere = join(root, "elsewhere");
      await powershell(
        `Set-ItemProperty -Path ${quote(`HKCU:\\${previousDataKey}`)} -Name 'Inno Setup: App Path' -Value ${quote(join(root, "other"))}`,
      );
      await (
        await startInstall({
          version: "nested-third",
          executable: "앱.exe",
          config: declarations,
          tasks: "",
          destination: elsewhere,
          payloadFiles: relocationPayload,
        })
      ).finish();
      expect(await Bun.file(join(nested, "unins000.exe")).exists()).toBe(true);
      expect(await Bun.file(join(nested, "앱.exe")).exists()).toBe(false);
    } finally {
      await removeInstallRecord(fixture);
      await cleanup();
    }
  },
  deadline("packagedAudit"),
);

test.skipIf(!iscc)(
  "native relocation reports a locked old executable and finishes the cleanup on the next run",
  async () => {
    if (!iscc) {
      throw new Error("ISCC is required.");
    }
    const fixture = await createNativeAssociationFixture(iscc);
    const {
      root,
      installDir,
      declarations,
      previousDataKey,
      startInstall,
      query,
      cleanup,
    } = fixture;
    const moved = join(root, "moved");
    const oldExecutable = join(installDir, "앱.exe");
    try {
      await (
        await startInstall({
          version: "locked-first",
          executable: "앱.exe",
          config: declarations,
          tasks: "fileassociations,urlschemes",
          payloadFiles: relocationPayload,
        })
      ).finish();
      const release = await preventFileDeletion(oldExecutable);
      try {
        await (
          await startInstall({
            version: "locked-second",
            executable: "앱.exe",
            config: declarations,
            tasks: "fileassociations,urlschemes",
            destination: moved,
            failure: "relocation-cleanup",
            payloadFiles: relocationPayload,
          })
        ).finish();
      } finally {
        release();
      }
      expect(await Bun.file(oldExecutable).exists()).toBe(true);
      expect(
        await query(
          previousDataKey,
          "Inno Setup CodeFile: PendingAssociationOwner",
        ),
      ).toBe(oldExecutable);
      await (
        await startInstall({
          version: "locked-third",
          executable: "앱.exe",
          config: declarations,
          tasks: "fileassociations,urlschemes",
          destination: moved,
          payloadFiles: relocationPayload,
        })
      ).finish();
      expect(await Bun.file(oldExecutable).exists()).toBe(false);
      expect(
        await Bun.file(join(installDir, "data", "config.json")).exists(),
      ).toBe(false);
      expect(
        await query(
          previousDataKey,
          "Inno Setup CodeFile: PendingAssociationOwner",
        ),
      ).toBe("");
    } finally {
      await removeInstallRecord(fixture);
      await cleanup();
    }
  },
  deadline("packagedAudit"),
);

test.skipIf(!iscc)(
  "native relocation to a link of the old folder removes nothing",
  async () => {
    if (!iscc) {
      throw new Error("ISCC is required.");
    }
    const fixture = await createNativeAssociationFixture(iscc);
    const {
      root,
      installDir,
      declarations,
      startInstall,
      powershell,
      quote,
      cleanup,
    } = fixture;
    const link = join(root, "link");
    try {
      await (
        await startInstall({
          version: "link-first",
          executable: "앱.exe",
          config: declarations,
          tasks: "",
          payloadFiles: relocationPayload,
        })
      ).finish();
      await powershell(
        `New-Item -ItemType Junction -Path ${quote(link)} -Target ${quote(installDir)} | Out-Null`,
      );
      await (
        await startInstall({
          version: "link-second",
          executable: "앱.exe",
          config: declarations,
          tasks: "",
          destination: link,
          payloadFiles: relocationPayload,
        })
      ).finish();
      // Both paths are one folder: the files the second install just wrote must remain.
      expect(await Bun.file(join(installDir, "앱.exe")).exists()).toBe(true);
      expect(await Bun.file(join(installDir, "unins000.exe")).exists()).toBe(
        true,
      );
      expect(
        await Bun.file(join(installDir, "data", "config.json")).exists(),
      ).toBe(true);
    } finally {
      await powershell(
        `if (Test-Path ${quote(link)}) { (Get-Item ${quote(link)}).Delete() }`,
      );
      await removeInstallRecord(fixture);
      await cleanup();
    }
  },
  deadline("packagedAudit"),
);

test.skipIf(!iscc)(
  "native relocation that fails before cleanup keeps the old uninstaller path and removes it on retry",
  async () => {
    if (!iscc) {
      throw new Error("ISCC is required.");
    }
    const fixture = await createNativeAssociationFixture(iscc);
    const {
      root,
      installDir,
      declarations,
      previousDataKey,
      startInstall,
      restoreRegistrationFault,
      query,
      cleanup,
    } = fixture;
    const moved = join(root, "moved");
    const config = {
      files: declarations.files,
    };
    const oldUninstaller = join(installDir, "unins000.exe");
    try {
      await (
        await startInstall({
          version: "pending-first",
          executable: "앱.exe",
          config,
          tasks: "fileassociations",
          payloadFiles: relocationPayload,
        })
      ).finish();
      // The registration fails after the new files are installed, before any cleanup.
      try {
        await (
          await startInstall({
            version: "pending-second",
            executable: "앱.exe",
            config,
            tasks: "fileassociations",
            destination: moved,
            failure: "write",
            fault: "icon",
            payloadFiles: relocationPayload,
          })
        ).finish();
      } finally {
        await restoreRegistrationFault("pending-second", "icon");
      }
      expect(await Bun.file(join(installDir, "앱.exe")).exists()).toBe(true);
      expect(await Bun.file(oldUninstaller).exists()).toBe(true);
      // Inno's own record already names the new folder; only the saved path remembers the old one.
      expect(await query(previousDataKey, "Inno Setup: App Path")).toBe(moved);
      expect(
        await query(previousDataKey, "Inno Setup CodeFile: PendingUninstaller"),
      ).toBe(oldUninstaller);
      await (
        await startInstall({
          version: "pending-third",
          executable: "앱.exe",
          config,
          tasks: "fileassociations",
          destination: moved,
          payloadFiles: relocationPayload,
        })
      ).finish();
      expect(await Bun.file(oldUninstaller).exists()).toBe(false);
      expect(await Bun.file(join(installDir, "앱.exe")).exists()).toBe(false);
      expect(
        await query(previousDataKey, "Inno Setup CodeFile: PendingUninstaller"),
      ).toBe("");
    } finally {
      await removeInstallRecord(fixture);
      await cleanup();
    }
  },
  deadline("packagedAudit"),
);

test.skipIf(!iscc)(
  "native relocation points the app, uninstall and desktop links at the new installation",
  async () => {
    if (!iscc) {
      throw new Error("ISCC is required.");
    }
    const fixture = await createNativeAssociationFixture(iscc);
    const {
      identifier,
      root,
      declarations,
      startInstall,
      powershell,
      quote,
      cleanup,
    } = fixture;
    const first = join(root, "first");
    const moved = join(root, "moved");
    const startMenuGroup = `Join-Path $env:APPDATA ${quote(`Microsoft\\Windows\\Start Menu\\Programs\\${identifier}`)}`;
    const desktop = "[Environment]::GetFolderPath('Desktop')";
    // Shell.Application keeps Unicode link names, which the scripting host converts to ANSI.
    const shellLinks = (dir: string, filter: string, edit = "") =>
      powershell(
        `$sh=New-Object -ComObject Shell.Application; $folder=$sh.Namespace((${dir})); foreach ($item in $folder.Items()) { if ($item.IsLink -and $item.Name -like ${quote(filter)}) { $l=$item.GetLink; ${edit} $l.Path + '|' + $l.Arguments + '|' + $l.WorkingDirectory } }`,
      );
    const userEdit = (workingDirectory: string) =>
      `if ($l.Path -like '*\\App.exe') { $l.Arguments='--user'; ${workingDirectory} $l.Save() }`;
    const install = async (version: string, destination: string) =>
      (
        await startInstall({
          version,
          executable: "App.exe",
          config: declarations,
          tasks: "desktopicon",
          shortcuts: true,
          payloadFiles: relocationPayload,
          destination,
        })
      ).finish();
    try {
      await install("links-first", first);
      // A user argument proves the links are updated in place, not recreated. The desktop link
      // also gets a start folder the user chose.
      await shellLinks(startMenuGroup, "*", userEdit(""));
      await shellLinks(
        desktop,
        `*${identifier}*`,
        userEdit(`$l.WorkingDirectory=${quote(root)};`),
      );
      const before = await shellLinks(desktop, `*${identifier}*`);
      expect(before).toBe(`${join(first, "App.exe")}|--user|${root}`);
      await install("links-second", moved);
      const movedExecutable = join(moved, "App.exe");
      // A start folder the user chose is kept; the default one follows the move.
      expect(await shellLinks(desktop, `*${identifier}*`)).toBe(
        `${movedExecutable}|--user|${root}`,
      );
      const menu = (await shellLinks(startMenuGroup, "*"))
        .split(/\r?\n/)
        .sort();
      expect(menu).toHaveLength(2);
      expect(menu).toContain(`${movedExecutable}|--user|${moved}`);
      expect(
        menu.filter((line) =>
          line.startsWith(`${join(moved, "unins000.exe")}|`),
        ),
      ).toHaveLength(1);
    } finally {
      await powershell(
        `Remove-Item -LiteralPath (${startMenuGroup}) -Recurse -Force -ErrorAction SilentlyContinue; Get-ChildItem -LiteralPath (${desktop}) -Filter ${quote(`*${identifier}*.lnk`)} | Remove-Item -Force`,
      );
      await removeInstallRecord(fixture);
      await cleanup();
    }
  },
  deadline("packagedAudit"),
);
