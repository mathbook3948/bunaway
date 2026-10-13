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
  expect(() => parse(associations, "win-store-msix")).toThrow("unknown field");
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
    desktopShortcut: false,
    startMenuShortcut: false,
    webView2: "check",
    appDataDir: "{localappdata}\\bunaway\\association-test",
    preserveUserData: true,
    assetPaths: [],
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
  async function denyValueWrites(path: string) {
    const descriptor = await powershell(
      `$key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey(${quote(path)},[Microsoft.Win32.RegistryKeyPermissionCheck]::ReadWriteSubTree,[System.Security.AccessControl.RegistryRights]::ReadPermissions -bor [System.Security.AccessControl.RegistryRights]::ChangePermissions); try { $acl=$key.GetAccessControl([System.Security.AccessControl.AccessControlSections]::Access); $acl.GetSecurityDescriptorSddlForm([System.Security.AccessControl.AccessControlSections]::Access); $rule=[System.Security.AccessControl.RegistryAccessRule]::new([System.Security.Principal.WindowsIdentity]::GetCurrent().User,[System.Security.AccessControl.RegistryRights]::SetValue,[System.Security.AccessControl.AccessControlType]::Deny); $acl.AddAccessRule($rule); $key.SetAccessControl($acl) } finally { $key.Dispose() }`,
    );
    return () => restoreAccess(path, descriptor);
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
  async function install(
    version: string,
    executable: string,
    config: ChannelConfig["associations"],
    tasks?: string,
    failure?:
      | "collision"
      | "write"
      | "cleanup"
      | "payload-cleanup"
      | "pending-owner",
    fault?: "icon" | "mapping",
    destination = installDir,
  ) {
    const staging = join(root, version);
    const payload = join(staging, "app");
    const output = join(staging, "installer");
    await mkdir(payload, {
      recursive: true,
    });
    await mkdir(output);
    await Bun.write(join(payload, executable), "installer payload fixture");
    const iss = join(staging, "setup.iss");
    let rendered = script(identifier, payload, output, executable, config);
    if (failure === "payload-cleanup" || failure === "pending-owner") {
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
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    const log = await Bun.file(logPath).text();
    if (failure) {
      expect(exitCode).not.toBe(0);
      if (failure === "pending-owner") {
        // PrepareToInstall rejects the rename before payload and previous-data writes.
        expect(exitCode).toBe(7);
      } else if (failure !== "collision") {
        expect(exitCode).toBe(1);
      }
      const failureMessages = {
        collision: "App association is owned by a different command",
        write: "Could not register app association",
        cleanup: "Could not remove app association value",
        "payload-cleanup": "Could not remove previous app executable",
        "pending-owner": "Complete the previous executable cleanup",
      };
      expect(log).toContain(failureMessages[failure]);
    } else if (exitCode !== 0) {
      throw new Error(
        `Installer failed (${exitCode}): ${stdout} ${stderr}\n${log}`,
      );
    }
  }
  async function uninstall() {
    const executable = join(installDir, "unins000.exe");
    if (!(await Bun.file(executable).exists())) {
      return;
    }
    await must(executable, silent);
    for (let i = 0; i < 200; i++) {
      if (!(await Bun.file(executable).exists())) {
        return;
      }
      await Bun.sleep(50);
    }
    throw new Error("Uninstaller did not finish.");
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
    restoreRegistrationFault,
    install,
    uninstall,
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
