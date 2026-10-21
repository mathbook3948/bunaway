import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  sanitizeWindowsFileName,
  toastActivatorClsid,
} from "@bunaway/protocol";
import {
  type ChannelConfig,
  CODES,
  type StageContext,
} from "../../contract.ts";
import { renderAssociationCode } from "./associations.ts";
import { renderAutostartCode } from "./autostart.ts";
import {
  findIscc,
  findWindowsKitTool,
  must,
  WINDOWS_MIN_BUILD,
  WINDOWS_MIN_VERSION,
  WINDOWS_VERSION_PART_MAX,
} from "./common.ts";
import { innoIdentity } from "./inno-identity.ts";
import { renderInstallationStateCode } from "./installation-state.ts";
import { RELOCATION_PAYLOAD_LIST, renderRelocationCode } from "./relocation.ts";
import { signingArgs } from "./sign.ts";

// Inno Setup installer generation shared by win-direct and
// win-store-unpackaged. The script encodes the channel's install contract:
// install location by scope, WebView2 handling (check-only or bundled
// bootstrapper), shortcuts, per-user data preservation on uninstall, and
// over-install updates keyed by a stable AppId GUID.

/** Inputs used to render the Inno script and its install/update behavior. */
export interface InnoOptions {
  name: string;
  identifier: string;
  appId?: string;
  version: string;
  publisher: string;
  scope: "perUser" | "perMachine";
  payloadDir: string;
  outputDir: string;
  outputBaseName: string;
  iconFile?: string;
  desktopShortcut: boolean;
  startMenuShortcut: boolean;
  autostart?: boolean;
  webView2: "check" | "bootstrap" | "offline";
  // Absolute path to Microsoft's Evergreen bootstrapper; only valid for
  // webView2="bootstrap". Store EXE/MSI submissions must be standalone and
  // never download at install time.
  bootstrapperPath?: string;
  // Absolute path to the Microsoft-signed Evergreen Standalone Installer;
  // only valid for webView2="offline". The installer embeds it so the runtime
  // installs without a network connection.
  offlineInstallerPath?: string;
  // Absolute data root the host writes to; kept on uninstall unless the
  // channel config opts out (uninstall.preserveUserData=false).
  appDataDir: string;
  preserveUserData: boolean;
  assetPaths: string[];
  // Absolute path to a text file listing every payload file (relative, one per line, UTF-8
  // with BOM). Setup unpacks it to remove the files of a previous installation in another folder.
  payloadListPath?: string;
  executableName?: string;
  signed?: boolean;
  minVersion?: string;
  associations?: ChannelConfig["associations"];
}

/** File name the Standalone Installer takes in Setup's temporary directory. */
const OFFLINE_INSTALLER_NAME = "MicrosoftEdgeWebView2RuntimeInstaller.exe";

function issLiteral(value: string, constants = true): string {
  if (/[\r\n\0]/.test(value)) {
    throw new Error("Inno values must not contain line breaks or NUL.");
  }
  return constants ? value.replace(/{/g, "{{") : value;
}

function issParameter(value: string, constants = true): string {
  return issLiteral(value, constants).replace(/"/g, '""');
}

/** Replaces forbidden path characters and trims trailing dots and spaces. */
export function installerDirectoryName(name: string): string {
  return sanitizeWindowsFileName(name) || "App";
}

/**
 * Rejects unsupported executable names, Windows versions and scope combinations
 * before any text is rendered; returns the minimum version parts.
 */
function validateInnoOptions(options: InnoOptions): number[] {
  if (/^unins\d+\.exe$/i.test(options.executableName ?? "")) {
    throw new Error(
      "GUI executable name conflicts with the Inno uninstaller (uninsNNN.exe).",
    );
  }
  const minVersion = options.minVersion ?? WINDOWS_MIN_VERSION;
  if (!/^\d+\.\d+(?:\.\d+)?(?:\.0)?$/.test(minVersion)) {
    throw new Error("Windows minVersion must be major.minor[.build[.0]].");
  }
  const parts = minVersion.split(".").map(Number);
  if (
    parts.some((part) => part > WINDOWS_VERSION_PART_MAX) ||
    (parts[0] ?? 0) < 10 ||
    (parts[0] === 10 && parts[1] === 0 && (parts[2] ?? 0) < WINDOWS_MIN_BUILD)
  ) {
    throw new Error(
      "Windows minVersion must be >= 10.0.17763.0 (bundled Bun requirement).",
    );
  }
  const perUser = options.scope === "perUser";
  if (!perUser && !options.preserveUserData) {
    throw new Error(
      "perMachine installs must preserve user data; cleanup requires a perUser install.",
    );
  }
  if (!perUser && options.autostart) {
    throw new Error("Installer autostart requires perUser scope.");
  }
  return parts;
}

/** Values derived from the options once and shared by every script section. */
type InnoContext = ReturnType<typeof createInnoContext>;

function createInnoContext(options: InnoOptions, parts: number[]) {
  const perUser = options.scope === "perUser";
  const shortcutName = installerDirectoryName(options.name);
  const directoryName = issLiteral(shortcutName);
  const identifier = issLiteral(options.identifier);
  const executableName = options.executableName ?? `${options.identifier}.exe`;
  const executable = issParameter(executableName);
  const executableLiteral = issLiteral(executableName, false).replace(
    /'/g,
    "''",
  );
  const appId = issParameter(options.appId ?? options.identifier);
  // The notification plugin derives the same class identifier from the application identifier and
  // registers it at run time, so a click on a toast can start the installed app.
  const toastClsid = toastActivatorClsid(options.appId ?? options.identifier);
  const menuLink = `{group}\\${directoryName}.lnk`;
  const uninstallLink = `{group}\\${directoryName} 제거.lnk`;
  const desktopLink = `{autodesktop}\\${directoryName} (${identifier}).lnk`;
  const shortcutCheck = (path: string) =>
    `; Flags: uninsneveruninstall; Check: ShouldCreateShortcut('${path.replace(/'/g, "''")}')`;
  const defaultDir = perUser
    ? `{localappdata}\\Programs\\${identifier}`
    : `{autopf}\\${identifier}`;
  const installationState = renderInstallationStateCode(options.identifier);
  const relocation = renderRelocationCode({
    scope: options.scope,
    startMenuShortcut: options.startMenuShortcut,
    hasPayloadList: options.payloadListPath !== undefined,
  });
  return {
    options,
    perUser,
    parts,
    directoryName,
    identifier,
    executableName,
    executable,
    executableLiteral,
    appId,
    toastClsid,
    menuLink,
    uninstallLink,
    desktopLink,
    installationState,
    relocation,
    shortcutCheck,
    defaultDir,
  };
}

/** The [Setup] section: identity, install location, privileges and optional signing and icon. */
function setupSection(context: InnoContext): string[] {
  const {
    options,
    perUser,
    parts,
    identifier,
    executable,
    installationState,
    defaultDir,
  } = context;
  const lines: string[] = [
    "; Generated by @bunaway/packaging. Do not edit.",
    "[Setup]",
    `AppId=${issLiteral(innoIdentity(options.identifier).appId)}`,
    `SetupMutex=${installationState.setupMutex}`,
    `AppName=${issLiteral(options.name)}`,
    `AppVerName=${issLiteral(options.name)} ${options.version}`,
    `AppVersion=${options.version}`,
    `AppPublisher=${issLiteral(options.publisher)}`,
    `DefaultDirName=${defaultDir}`,
    `DefaultGroupName=${identifier}`,
    "WizardStyle=modern",
    "Compression=lzma2",
    "SolidCompression=yes",
    "ArchitecturesAllowed=x64compatible",
    "ArchitecturesInstallIn64BitMode=x64compatible",
    // Inno uses three parts; the optional MSIX-style revision must be zero.
    `MinVersion=${parts.slice(0, 3).join(".")}`,
    "CloseApplications=yes",
    // Each installer is a complete snapshot; old data-deletion records must
    // not override the current uninstall policy.
    "UninstallLogMode=overwrite",
    "ChangesAssociations=yes",
    `UninstallDisplayIcon={app}\\${executable}`,
    `OutputDir=${options.outputDir}`,
    `OutputBaseFilename=${options.outputBaseName}`,
    perUser ? "PrivilegesRequired=lowest" : "PrivilegesRequired=admin",
  ];
  if (options.signed) {
    lines.push(
      "SignTool=bunaway",
      "SignedUninstaller=yes",
      `SignedUninstallerDir=${join(options.outputDir, "..", "inno-signing")}`,
    );
  }
  if (options.iconFile) {
    lines.push(`SetupIconFile=${options.iconFile}`);
  }
  return lines;
}

/** The [Files] section: payload and the optional bundled WebView2 bootstrapper. */
function filesSection(context: InnoContext): string[] {
  const { options } = context;
  const lines: string[] = [];
  lines.push("", "[Files]");
  lines.push(
    `Source: "${issParameter(options.payloadDir, false)}\\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs`,
  );
  if (options.payloadListPath) {
    lines.push(
      `Source: "${issParameter(options.payloadListPath, false)}"; DestDir: "{tmp}"; DestName: "${RELOCATION_PAYLOAD_LIST}"; Flags: dontcopy`,
    );
  }
  if (options.bootstrapperPath) {
    lines.push(
      `Source: "${issParameter(options.bootstrapperPath, false)}"; DestDir: "{tmp}"; DestName: "MicrosoftEdgeWebview2Setup.exe"; Flags: dontcopy`,
    );
  }
  if (options.offlineInstallerPath) {
    // The installer is already compressed; skip a second pass over ~170 MB.
    lines.push(
      `Source: "${issParameter(options.offlineInstallerPath, false)}"; DestDir: "{tmp}"; DestName: "${OFFLINE_INSTALLER_NAME}"; Flags: dontcopy nocompression`,
    );
  }
  return lines;
}

/** The [Tasks] section: opt-in associations, autostart and desktop shortcut. */
function tasksSection(context: InnoContext): string[] {
  const { options } = context;
  const lines: string[] = [];
  if (options.desktopShortcut || options.associations || options.autostart) {
    lines.push("", "[Tasks]");
  }
  if (options.associations?.files) {
    lines.push(
      'Name: "fileassociations"; Description: "파일 열기 앱으로 등록"; GroupDescription: "앱 연결:"; Flags: unchecked',
    );
  }
  if (options.associations?.urlSchemes) {
    lines.push(
      'Name: "urlschemes"; Description: "URL 열기 앱으로 등록"; GroupDescription: "앱 연결:"; Flags: unchecked',
    );
  }
  if (options.autostart) {
    lines.push(
      'Name: "autostart"; Description: "로그인 시 자동 실행"; GroupDescription: "자동 실행:"; Flags: unchecked checkedonce',
    );
  }
  if (options.desktopShortcut) {
    lines.push(
      `Name: "desktopicon"; Description: "${issParameter(`${options.name} 바로가기 만들기`)}"; GroupDescription: "바로가기:"`,
    );
  }
  return lines;
}

/** The [Icons] section: start menu, uninstall and desktop shortcuts. */
function iconsSection(context: InnoContext): string[] {
  const {
    options,
    directoryName,
    identifier,
    executable,
    appId,
    toastClsid,
    menuLink,
    uninstallLink,
    desktopLink,
    shortcutCheck,
  } = context;
  const lines: string[] = [];
  if (options.startMenuShortcut || options.desktopShortcut) {
    lines.push("", "[Icons]");
    if (options.startMenuShortcut) {
      // Windows starts the app for a toast click only through a Start menu shortcut that names the
      // activator class. Inno takes the GUID without braces for this parameter.
      lines.push(
        `Name: "{group}\\${directoryName}"; Filename: "{app}\\${executable}"; WorkingDir: "{app}"; IconFilename: "{app}\\${executable}"; AppUserModelID: "${appId}"; AppUserModelToastActivatorCLSID: "${toastClsid}"${shortcutCheck(menuLink)}`,
      );
      lines.push(
        `Name: "{group}\\${directoryName} 제거"; Filename: "{uninstallexe}"${shortcutCheck(uninstallLink)}`,
      );
    }
    if (options.desktopShortcut) {
      lines.push(
        `Name: "{autodesktop}\\${directoryName} (${identifier})"; Filename: "{app}\\${executable}"; WorkingDir: "{app}"; IconFilename: "{app}\\${executable}"; AppUserModelID: "${appId}"; Tasks: desktopicon${shortcutCheck(desktopLink)}`,
      );
    }
  }
  return lines;
}

/** The [Run] section and, when user data is not preserved, [UninstallDelete]. */
function runAndDeleteSections(context: InnoContext): string[] {
  const { options, executable } = context;
  const lines: string[] = [];
  // runasoriginaluser starts the app with the user's own token. A perMachine Setup is elevated, and
  // without the flag the launched app would inherit that administrator token. perUser Setup is not
  // elevated, so the flag changes nothing there and is kept for one script shape.
  lines.push(
    "",
    "[Run]",
    `Filename: "{app}\\${executable}"; WorkingDir: "{app}"; Description: "${issParameter(`Launch ${options.name}`)}"; Flags: postinstall nowait skipifsilent unchecked runasoriginaluser`,
  );

  if (!options.preserveUserData) {
    lines.push(
      "",
      "[UninstallDelete]",
      `Type: filesandordirs; Name: "${options.appDataDir}"`,
    );
  }
  return lines;
}

/**
 * A GUID as the 16 bytes a shortcut file stores (Windows field order), as a comma separated
 * list of decimal values that the generated Pascal compares byte by byte.
 */
function guidFileBytes(guid: string): string {
  const hex = guid.replaceAll("-", "");
  const bytes = Array.from(
    {
      length: 16,
    },
    (_, index) => Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16),
  );
  const ordered = [
    ...bytes.slice(0, 4).reverse(),
    ...bytes.slice(4, 6).reverse(),
    ...bytes.slice(6, 8).reverse(),
    ...bytes.slice(8),
  ];
  return ordered.join(", ");
}

/** Pascal [Code] support: COM types, install state, association and autostart code, WebView2 detection. */
function codeSupportSection(context: InnoContext): string[] {
  const {
    options,
    perUser,
    executableName,
    executableLiteral,
    installationState,
  } = context;
  const lines: string[] = [];
  lines.push(
    "",
    "[Code]",
    `// Native icon inspection preserves Unicode and supports output parameters.
// Keep the unused methods: their positions define the COM vtable.
type
  IShellLinkW = interface(IUnknown)
    '{000214F9-0000-0000-C000-000000000046}'
    procedure GetPath;
    procedure GetIDList;
    procedure SetIDList;
    procedure GetDescription;
    procedure SetDescription;
    procedure GetWorkingDirectory;
    procedure SetWorkingDirectory;
    procedure GetArguments;
    procedure SetArguments;
    procedure GetHotkey;
    procedure SetHotkey;
    procedure GetShowCmd;
    procedure SetShowCmd;
    function GetIconLocation(Path: String; Size: Integer; out Index: Integer): HResult;
  end;
  IPersistFile = interface(IUnknown)
    '{0000010B-0000-0000-C000-000000000046}'
    procedure GetClassID;
    procedure IsDirty;
    function Load(Filename: String; Mode: Longint): HResult;
  end;
`,
    installationState.declarations,
    context.relocation.declarations,
    "var PreviousExecutableName: String;",
    "    PreviousInstallDir: String;",
    "    PendingAssociationExecutableName: String;",
    "    PendingAssociationInstallDir: String;",
    "    PendingAssociationDataSaved: Boolean;",
    "    PostInstallError: String;",
    // Identity capture and validation reuse the checked registry reader below.
    renderAssociationCode(
      options.identifier,
      executableName,
      options.name,
      options.associations,
      options.scope,
    ),
    installationState.procedures,
    "",
    "function IsSafeExecutableName(const Name: String): Boolean;",
    "var I: Integer;",
    "begin",
    "  Result := False;",
    "  if Name = '' then Exit;",
    "  if CompareText(ExtractFileExt(Name), '.exe') <> 0 then Exit;",
    "  if (Name[Length(Name)] = '.') or (Name[Length(Name)] = ' ') then Exit;",
    "  for I := 1 to Length(Name) do",
    "    if (Ord(Name[I]) < 32) or (Name[I] = '<') or (Name[I] = '>') or",
    "       (Name[I] = ':') or (Name[I] = '\"') or (Name[I] = '/') or",
    "       (Name[I] = '\\') or (Name[I] = '|') or (Name[I] = '?') or",
    "       (Name[I] = '*') then Exit;",
    "  Result := True;",
    "end;",
    "",
    "procedure LoadPendingAssociationOwner;",
    "var Owner: String;",
    "begin",
    "  // One registry value keeps the executable and directory in the same record.",
    "  Owner := InstallationSnapshot.PendingOwner;",
    "  if Owner <> '' then begin",
    "    PendingAssociationExecutableName := ExtractFileName(Owner);",
    "    PendingAssociationInstallDir := ExtractFileDir(Owner);",
    "  end else begin",
    "    PendingAssociationExecutableName := InstallationSnapshot.ExecutableName;",
    "    PendingAssociationInstallDir := InstallationSnapshot.InstallDir;",
    "  end;",
    "  if not IsSafeExecutableName(PendingAssociationExecutableName) or (PendingAssociationInstallDir = '') then begin",
    "    PendingAssociationExecutableName := '';",
    "    PendingAssociationInstallDir := '';",
    "  end;",
    "end;",
    "",
    ...(perUser
      ? [
          renderAutostartCode(
            options.appId ?? options.identifier,
            options.autostart ?? false,
          ),
        ]
      : []),
    "procedure PreflightPendingExecutable;",
    "var CurrentExecutableName, CurrentInstallDir: String;",
    "    HasDistinctPredecessor, ChangesInstallationIdentity: Boolean;",
    "begin",
    "  // One recovery record cannot represent both Old.exe and New.exe after a",
    "  // third name change. Read the validated current snapshot, not the retry",
    "  // cleanup identity substituted into PreviousExecutableName below.",
    "  if InstallationSnapshot.PendingOwner = '' then Exit;",
    "  CurrentExecutableName := InstallationSnapshot.ExecutableName;",
    "  CurrentInstallDir := InstallationSnapshot.InstallDir;",
    "  if (PendingAssociationExecutableName = '') or (PendingAssociationInstallDir = '') or",
    "     not IsSafeExecutableName(CurrentExecutableName) or (CurrentInstallDir = '') then",
    "    RaiseException('Could not validate the pending executable cleanup identity.');",
    "  HasDistinctPredecessor := (CompareText(PendingAssociationExecutableName, CurrentExecutableName) <> 0) or",
    "    (CompareText(AddBackslash(PendingAssociationInstallDir), AddBackslash(CurrentInstallDir)) <> 0);",
    `  ChangesInstallationIdentity := (CompareText(CurrentExecutableName, '${executableLiteral}') <> 0) or`,
    "    (CompareText(AddBackslash(CurrentInstallDir), AddBackslash(ExpandConstant('{app}'))) <> 0);",
    "  if HasDistinctPredecessor and ChangesInstallationIdentity then",
    "    RaiseException('Complete the previous executable cleanup before changing the executable name or installation directory. Retry the installer for ' + CurrentExecutableName + ' or uninstall the current installation.');",
    "end;",
    "",
    "function HasRuntimeVersion(const Version: String): Boolean;",
    "var PackedVersion: Int64;",
    "begin",
    "  Result := False;",
    "  if StrToVersion(Version, PackedVersion) then",
    "    Result := ComparePackedVersion(PackedVersion, 0) > 0;",
    "end;",
    "",
    "// Evergreen WebView2 runtime presence check (Microsoft-documented GUID).",
    "function HasWebView2Runtime: Boolean;",
    "var Version: String;",
    "begin",
    "  Result := RegQueryStringValue(HKLM, 'SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', Version) and HasRuntimeVersion(Version);",
    "  if not Result then",
    "    Result := RegQueryStringValue(HKLM, 'SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', Version) and HasRuntimeVersion(Version);",
    ...(perUser
      ? [
          "  if not Result then",
          "    Result := RegQueryStringValue(HKCU, 'SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', Version) and HasRuntimeVersion(Version);",
        ]
      : []),
    "end;",
    "",
  );
  return lines;
}

/** PrepareToInstall: pending cleanup preflight and optional WebView2 bootstrapper run. */
function prepareToInstallSection(context: InnoContext): string[] {
  const { options, perUser } = context;
  const lines: string[] = [];
  lines.push(
    "function PrepareToInstall(var NeedsRestart: Boolean): String;",
    ...(options.bootstrapperPath || options.offlineInstallerPath
      ? [
          "var ResultCode: Integer;",
        ]
      : []),
    "begin",
    "  Result := '';",
    "  try",
    "    ValidateInstallationSnapshot;",
    "    PreflightPendingExecutable;",
    "    PreflightAssociations;",
    ...(perUser
      ? [
          "    PreflightAutostart;",
        ]
      : []),
    "  except",
    "    Result := GetExceptionMessage;",
    "    Exit;",
    "  end;",
    ...(options.bootstrapperPath
      ? [
          "  if HasWebView2Runtime then Exit;",
          "  ExtractTemporaryFile('MicrosoftEdgeWebview2Setup.exe');",
          "  if not Exec(ExpandConstant('{tmp}\\MicrosoftEdgeWebview2Setup.exe'), '/silent /install', '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then",
          "    Result := 'Could not start the WebView2 Runtime installer: ' + SysErrorMessage(ResultCode)",
          "  else if ResultCode <> 0 then",
          "    Result := 'WebView2 Runtime installation failed (exit code ' + IntToStr(ResultCode) + '). Check your internet connection and retry.'",
          "  else if not HasWebView2Runtime then",
          "    Result := 'WebView2 Runtime was not detected after installation. Install the runtime and retry.';",
        ]
      : []),
    ...(options.offlineInstallerPath
      ? [
          "  if HasWebView2Runtime then Exit;",
          "  try",
          `    ExtractTemporaryFile('${OFFLINE_INSTALLER_NAME}');`,
          "  except",
          "    Result := 'Could not unpack the WebView2 Runtime installer (check free disk space): ' + GetExceptionMessage;",
          "    Exit;",
          "  end;",
          `  if not Exec(ExpandConstant('{tmp}\\${OFFLINE_INSTALLER_NAME}'), '/silent /install', '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then`,
          "    Result := 'Could not start the WebView2 Runtime installer: ' + SysErrorMessage(ResultCode)",
          "  else if ResultCode <> 0 then",
          "    Result := 'WebView2 Runtime installation failed (exit code ' + IntToStr(ResultCode) + '). Run the installer as an administrator or install the WebView2 Runtime first.'",
          "  else if not HasWebView2Runtime then",
          "    Result := 'WebView2 Runtime was not detected after installation. Install the runtime and retry.';",
        ]
      : []),
    "end;",
    "",
  );
  return lines;
}

/** Predecessor executable, shortcut and obsolete asset cleanup, plus uninstall steps. */
function cleanupSection(context: InnoContext): string[] {
  const {
    options,
    perUser,
    executableLiteral,
    toastClsid,
    menuLink,
    uninstallLink,
    desktopLink,
  } = context;
  const toastClsidBytes = guidFileBytes(toastClsid);
  const lines: string[] = [];
  lines.push(
    "// Retained payloads are not in the overwritten uninstall log. Both retry and",
    "// uninstall may remove only a safe predecessor in this unchanged, plain directory.",
    "// Every component up to the drive must be an existing plain directory, so a",
    "// redirected parent is not followed.",
    "function IsPlainDirectoryChain(const Directory: String): Boolean;",
    "var Current, Drive: String; Entry: TFindRec;",
    "begin",
    "  Result := False;",
    "  Current := Directory;",
    "  Drive := ExtractFileDrive(Current);",
    "  if Drive = '' then Exit;",
    "  while CompareText(AddBackslash(Current), AddBackslash(Drive)) <> 0 do begin",
    "    if not FindFirst(Current, Entry) then Exit;",
    "    try",
    "      if ((Entry.Attributes and FILE_ATTRIBUTE_DIRECTORY) = 0) or",
    "         ((Entry.Attributes and FILE_ATTRIBUTE_REPARSE_POINT) <> 0) then Exit;",
    "    finally FindClose(Entry); end;",
    "    Current := ExtractFileDir(Current);",
    "    if Current = '' then Exit;",
    "  end;",
    "  Result := True;",
    "end;",
    "",
    "procedure RemovePreviousExecutable(const ExecutableName, InstallDir: String);",
    "var Path: String; Entry: TFindRec;",
    "begin",
    "  if not IsSafeExecutableName(ExecutableName) or (InstallDir = '') or",
    "     (CompareText(AddBackslash(InstallDir), AddBackslash(ExpandConstant('{app}'))) <> 0) or",
    `     (CompareText(ExecutableName, '${executableLiteral}') = 0) then Exit;`,
    "  if not IsPlainDirectoryChain(ExpandConstant('{app}')) then Exit;",
    "  Path := ExpandConstant('{app}') + '\\' + ExecutableName;",
    "  if CompareText(Path, ExpandConstant('{uninstallexe}')) = 0 then Exit;",
    "  if not FindFirst(Path, Entry) then Exit;",
    "  try",
    "    if ((Entry.Attributes and (FILE_ATTRIBUTE_DIRECTORY or FILE_ATTRIBUTE_REPARSE_POINT)) = 0) and",
    "       not DeleteFile(Path) then",
    "      RaiseException('Could not remove previous app executable: ' + Path);",
    "  finally",
    "    FindClose(Entry);",
    "  end;",
    "end;",
    "",
    String.raw`// Inspect only the configured path. Never search for renamed or moved links.
function ReadShortcut(const Filename: String; var Link: Variant; var Target: String): Boolean;
var Shell, Folder, Item: Variant; Entry: TFindRec;
begin
  Result := False;
  Target := '';
  if not FindFirst(ExtractFileDir(Filename), Entry) then Exit;
  try
    if (Entry.Attributes and FILE_ATTRIBUTE_REPARSE_POINT) <> 0 then Exit;
  finally FindClose(Entry); end;
  if not FindFirst(Filename, Entry) then Exit;
  try
    if (Entry.Attributes and (FILE_ATTRIBUTE_DIRECTORY or FILE_ATTRIBUTE_REPARSE_POINT)) <> 0 then Exit;
  finally FindClose(Entry); end;
  try
    // Shell.Application preserves Unicode paths that WScript.Shell can lose via ANSI conversion.
    Shell := CreateOleObject('Shell.Application');
    Folder := Shell.Namespace(ExtractFileDir(Filename));
    Item := Folder.ParseName(ExtractFileName(Filename));
    Link := Item.GetLink;
    Target := Link.Path;
    Result := True;
  except Log('Could not inspect shortcut: ' + Filename); end;
end;

function ShouldCreateShortcut(const Filename: String): Boolean;
var Entry: TFindRec;
begin
  Result := not FindFirst(ExpandConstant(Filename), Entry);
  if not Result then FindClose(Entry);
end;

procedure UpdateShortcut(const Filename: String);
var Link: Variant; Target, Arguments, IconPath: String; IconIndex: Integer;
    IconObject: IUnknown; IconLink: IShellLinkW; IconFile: IPersistFile;
begin
  if (PreviousExecutableName = '') or (PreviousInstallDir = '') or
     ((CompareText(PreviousExecutableName, '${executableLiteral}') = 0) and
      (CompareText(AddBackslash(PreviousInstallDir), AddBackslash(ExpandConstant('{app}'))) = 0)) then Exit;
  if not ReadShortcut(Filename, Link, Target) then Exit;
  if CompareText(Target, AddBackslash(PreviousInstallDir) + PreviousExecutableName) <> 0 then Exit;
  try
    Arguments := Link.Arguments;
    IconObject := CreateComObject(StringToGuid('{00021401-0000-0000-C000-000000000046}'));
    IconFile := IPersistFile(IconObject);
    OleCheck(IconFile.Load(Filename, 0));
    IconLink := IShellLinkW(IconObject);
    IconPath := StringOfChar(#0, 32768);
    OleCheck(IconLink.GetIconLocation(IconPath, Length(IconPath), IconIndex));
    StringChangeEx(IconPath, #0, '', True);
  except Log('Could not inspect shortcut properties: ' + Filename); Exit; end;
  if CompareText(IconPath, Target) = 0 then
    Link.SetIconLocation(ExpandConstant('{app}') + '\' + '${executableLiteral}', IconIndex);
  Link.Path := ExpandConstant('{app}') + '\' + '${executableLiteral}';
  Link.Arguments := Arguments;
  Link.Save(Filename);
end;

procedure DeleteShortcut(const Filename, ExpectedTarget: String);
var Link: Variant; Target: String;
begin
  if not ReadShortcut(Filename, Link, Target) then Exit;
  if CompareText(Target, ExpectedTarget) <> 0 then Exit;
  if not DeleteFile(Filename) then Log('Could not remove shortcut: ' + Filename);
end;
`,
    ...(options.startMenuShortcut
      ? [
          // ShouldCreateShortcut keeps an existing link, so an install made before the activator
          // existed would never gain the class. Setup recreates only this app's own Start menu link
          // (target is the current executable, class missing) and puts the user's arguments back.
          "var MenuLinkArguments: String;",
          "    MenuLinkRecreated: Boolean;",
          "",
          "function ShortcutHasToastActivator(const Filename: String): Boolean;",
          "var Content: AnsiString; Needle: array[0..15] of Integer; I, J: Integer; Found: Boolean;",
          "begin",
          "  Result := False;",
          `  ${toastClsidBytes
            .split(", ")
            .map((byte, index) => `Needle[${index}] := ${byte};`)
            .join(" ")}`,
          "  if not LoadStringFromFile(Filename, Content) then Exit;",
          // Compare raw bytes: a string search would convert through the ANSI code page and miss GUID bytes above 0x7F.
          "  for I := 1 to Length(Content) - 15 do begin",
          "    Found := True;",
          "    for J := 0 to 15 do",
          "      if Ord(Content[I + J]) <> Needle[J] then begin Found := False; Break; end;",
          "    if Found then begin Result := True; Exit; end;",
          "  end;",
          "end;",
          "",
          "procedure PrepareMenuLinkForToastActivator;",
          "var Path, Target: String; Link: Variant;",
          "begin",
          "  MenuLinkArguments := '';",
          "  MenuLinkRecreated := False;",
          `  Path := ExpandConstant('${menuLink.replace(/'/g, "''")}');`,
          "  if not ReadShortcut(Path, Link, Target) then Exit;",
          `  if CompareText(Target, ExpandConstant('{app}') + '\\' + '${executableLiteral}') <> 0 then Exit;`,
          "  if ShortcutHasToastActivator(Path) then Exit;",
          "  try",
          "    MenuLinkArguments := Link.Arguments;",
          "  except Log('Could not read shortcut arguments: ' + Path); Exit; end;",
          "  if DeleteFile(Path) then MenuLinkRecreated := True",
          "  else Log('Could not replace shortcut: ' + Path);",
          "end;",
          "",
          "procedure RestoreMenuLinkArguments;",
          "var Path, Target: String; Link: Variant;",
          "begin",
          "  if (not MenuLinkRecreated) or (MenuLinkArguments = '') then Exit;",
          `  Path := ExpandConstant('${menuLink.replace(/'/g, "''")}');`,
          "  if not ReadShortcut(Path, Link, Target) then Exit;",
          "  try",
          "    Link.Arguments := MenuLinkArguments;",
          "    Link.Save(Path);",
          "  except Log('Could not restore shortcut arguments: ' + Path); end;",
          "end;",
          "",
        ]
      : []),
    ...(perUser
      ? [
          "procedure RemoveToastActivatorRegistration(const Key: String);",
          "begin",
          "  if RegKeyExists(HKCU64, Key) and not RegDeleteKeyIncludingSubkeys(HKCU64, Key) then",
          "    Log('Could not remove toast activator registration: ' + Key);",
          "end;",
          "",
        ]
      : []),
    context.relocation.procedures,
    "procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);",
    "begin",
    "  if CurUninstallStep <> usUninstall then Exit;",
    "  ValidateInstallationSnapshot;",
    ...(perUser
      ? [
          "  UninstallAutostart;",
          // The app writes this key when it starts, so Setup has no record of it. A perMachine
          // uninstall cannot reach other users' hives; their key then points at the removed program.
          `  RemoveToastActivatorRegistration('Software\\Classes\\CLSID\\{${toastClsid}}');`,
        ]
      : []),
    "  RemovePendingAssociationOwner;",
    "  RemoveAssociations(AssociationExecutable);",
    "  RemovePreviousExecutable(PendingAssociationExecutableName, PendingAssociationInstallDir);",
    "  RemoveRelocatedInstallation(PendingAssociationExecutableName, PendingAssociationInstallDir, nil);",
    ...[
      menuLink,
      desktopLink,
    ].map(
      (path) =>
        `  DeleteShortcut(ExpandConstant('${path.replace(/'/g, "''")}'), ExpandConstant('{app}') + '\\' + '${executableLiteral}');`,
    ),
    `  DeleteShortcut(ExpandConstant('${uninstallLink.replace(/'/g, "''")}'), ExpandConstant('{uninstallexe}'));`,
    "end;",
    "",
    "procedure PruneAssets(const Base, Relative: String; Current: TStringList);",
    "var Entry: TFindRec; Path, Child: String;",
    "begin",
    "  Path := Base + '\\' + Relative;",
    "  if not FindFirst(Path, Entry) then Exit;",
    "  try",
    "    if (Entry.Attributes and FILE_ATTRIBUTE_REPARSE_POINT) <> 0 then Exit;",
    "  finally",
    "    FindClose(Entry);",
    "  end;",
    "  if FindFirst(Path + '\\*', Entry) then begin",
    "    try",
    "      repeat",
    "        if (Entry.Name <> '.') and (Entry.Name <> '..') and",
    "           ((Entry.Attributes and FILE_ATTRIBUTE_REPARSE_POINT) = 0) then begin",
    "          Child := Relative + '\\' + Entry.Name;",
    "          if (Entry.Attributes and FILE_ATTRIBUTE_DIRECTORY) <> 0 then begin",
    "            PruneAssets(Base, Child, Current);",
    "            RemoveDir(Base + '\\' + Child);",
    "          end else if Current.IndexOf(Child) < 0 then begin",
    "            if not DeleteFile(Base + '\\' + Child) then",
    "              Log('Could not remove obsolete asset: ' + Child);",
    "          end;",
    "        end;",
    "      until not FindNext(Entry);",
    "    finally",
    "      FindClose(Entry);",
    "    end;",
    "  end;",
    "end;",
    "",
    "procedure CompleteInstallation;",
    "var Current: TStringList;",
    "begin",
    "  if (PreviousExecutableName = '') or (PreviousInstallDir = '') then",
    "    PreviousExecutableName := '';",
    "  Current := TStringList.Create;",
    "  try",
    "    Current.CaseSensitive := False;",
    "    Current.Sorted := True;",
    ...options.assetPaths.map(
      (path) =>
        `    Current.Add('${issLiteral(path, false).replace(/\//g, "\\").replace(/'/g, "''")}');`,
    ),
    "    PruneAssets(ExpandConstant('{app}'), 'licenses', Current);",
    ...(options.startMenuShortcut
      ? [
          "    RestoreMenuLinkArguments;",
        ]
      : []),
    ...[
      menuLink,
      desktopLink,
    ].map(
      (path) =>
        `    UpdateShortcut(ExpandConstant('${path.replace(/'/g, "''")}'));`,
    ),
    ...(options.startMenuShortcut
      ? [
          `    UpdateUninstallShortcut(ExpandConstant('${uninstallLink.replace(/'/g, "''")}'));`,
        ]
      : []),
    "    // Remove the predecessor last: every registration above already names the new executable.",
    "    if PostInstallError = '' then begin",
    "      RemovePreviousExecutable(PreviousExecutableName, PreviousInstallDir);",
    "      RemoveRelocatedInstallationWithPayload;",
    "    end;",
    "  finally",
    "    Current.Free;",
    "  end;",
    "end;",
    "",
  );
  return lines;
}

/** Install step ordering, exit code, close-application resources and previous-data registration. */
function installStepsSection(context: InnoContext): string[] {
  const { options, perUser, executableLiteral } = context;
  const lines: string[] = [];
  lines.push(
    "// Inno catches ssPostInstall exceptions without changing its successful exit code.",
    "// Keep independent payload cleanup running, then report any failure to both UI and automation.",
    "procedure CurStepChanged(CurStep: TSetupStep);",
    "begin",
    "  if CurStep = ssInstall then begin",
    "    // This is the last guard before Inno mutates payload and uninstall metadata.",
    "    ValidateInstallationSnapshot;",
    "    ValidateRelocationRecord;",
    ...(options.startMenuShortcut
      ? [
          // Runs before Inno creates the links, so a link without the activator class is recreated.
          "    PrepareMenuLinkForToastActivator;",
        ]
      : []),
    "    Exit;",
    "  end;",
    "  if CurStep <> ssPostInstall then Exit;",
    "  if PostInstallError <> '' then RaiseException(PostInstallError);",
    "  try",
    "    ValidateInstallationSnapshot;",
    "    InstallAssociations;",
    ...(perUser
      ? [
          "    InstallAutostart;",
        ]
      : []),
    "  except",
    "    PostInstallError := GetExceptionMessage;",
    "    Log(PostInstallError);",
    "  end;",
    "  try",
    "    ValidateInstallationSnapshot;",
    "    CompleteInstallation;",
    ...(perUser
      ? [
          "    if PostInstallError = '' then ClearPendingAutostartOwner;",
        ]
      : []),
    "    // Association reconciliation alone does not finish shortcut and payload cleanup.",
    "    // Keep the trusted predecessor until every required post-install stage succeeds.",
    "    if (PostInstallError = '') and PendingAssociationDataSaved then begin",
    "      ValidateInstallationSnapshot;",
    "      ClearPendingAssociationOwner;",
    "    end;",
    "  except",
    "    if PostInstallError <> '' then PostInstallError := PostInstallError + #13#10;",
    "    PostInstallError := PostInstallError + GetExceptionMessage;",
    "  end;",
    "  if PostInstallError <> '' then RaiseException(PostInstallError);",
    "end;",
    "",
    "function GetCustomSetupExitCode: Integer;",
    "begin",
    "  if PostInstallError <> '' then Result := 1 else Result := 0;",
    "end;",
    "",
    "procedure RegisterExtraCloseApplicationsResources;",
    "begin",
    "  if (PreviousExecutableName <> '') and (PreviousInstallDir <> '') and",
    `     not ((CompareText(PreviousExecutableName, '${executableLiteral}') = 0) and`,
    "          (CompareText(AddBackslash(PreviousInstallDir), AddBackslash(ExpandConstant('{app}'))) = 0)) and",
    "     FileExists(AddBackslash(PreviousInstallDir) + PreviousExecutableName) then",
    "    if not RegisterExtraCloseApplicationsResource(True, AddBackslash(PreviousInstallDir) + PreviousExecutableName) then",
    "      RaiseException('Could not check the previous app executable for running applications.');",
    "end;",
    "",
    "function InitializeSetup: Boolean;",
    "begin",
    "  Result := AcquireInstallationMaintenance;",
    "  if not Result then Exit;",
    "  CaptureInstallationSnapshot;",
    "  CaptureRelocationRecord;",
    "  PreviousExecutableName := InstallationSnapshot.ExecutableName;",
    "  if not IsSafeExecutableName(PreviousExecutableName) then",
    "    PreviousExecutableName := '';",
    "  PreviousInstallDir := InstallationSnapshot.InstallDir;",
    "  LoadPendingAssociationOwner;",
    ...(perUser
      ? [
          "  LoadAutostartOwners;",
        ]
      : []),
    "  // A failed upgrade or relocation already recorded the new EXE. Reuse its trusted pending",
    "  // predecessor, in this or another folder, for the close-resource, shortcut and EXE cleanup policy.",
    "  // PrepareToInstall rejects a target other than the recorded one while a predecessor is pending.",
    "  if (PendingAssociationExecutableName <> '') and (PendingAssociationInstallDir <> '') and",
    `     (CompareText(PreviousExecutableName, '${executableLiteral}') = 0) then begin`,
    "    PreviousExecutableName := PendingAssociationExecutableName;",
    "    PreviousInstallDir := PendingAssociationInstallDir;",
    "  end;",
    "  Result := True;",
    ...(options.webView2 === "check"
      ? [
          "  if not HasWebView2Runtime then begin",
          "    Log('WebView2 Runtime not detected; the app needs it at first run.');",
          "    if not WizardSilent then",
          "      MsgBox('Microsoft Edge WebView2 Runtime이 설치되어 있지 않습니다. 설치 후에도 앱이 첫 실행 시 필요합니다.', mbInformation, MB_OK);",
          "  end;",
        ]
      : []),
    "end;",
    "",
    "function InitializeUninstall: Boolean;",
    "begin",
    "  Result := AcquireInstallationMaintenance;",
    "  if not Result then Exit;",
    "  CaptureInstallationSnapshot;",
    "  LoadPendingAssociationOwner;",
    ...(perUser
      ? [
          "  LoadAutostartOwners;",
        ]
      : []),
    "end;",
    "",
    "procedure RegisterPreviousData(PreviousDataKey: Integer);",
    "var Owner: String;",
    "begin",
    "  try",
    "    // Inno deletes and recreates its uninstall key before this callback.",
    "    // ssInstall validated the captured identity before that native mutation;",
    "    // comparing live previous data here would reject every ordinary upgrade.",
    "    // Preserve an unresolved owner across repeated failed upgrades before Inno",
    "    // replaces the current executable record. ssPostInstall clears it on recovery.",
    "    if PendingAssociationExecutableName = '' then begin",
    "      PendingAssociationExecutableName := PreviousExecutableName;",
    "      PendingAssociationInstallDir := PreviousInstallDir;",
    "    end;",
    "    Owner := '';",
    "    if (PendingAssociationExecutableName <> '') and (PendingAssociationInstallDir <> '') then",
    "      Owner := AddBackslash(PendingAssociationInstallDir) + PendingAssociationExecutableName;",
    "    if not SetPreviousData(PreviousDataKey, 'PendingAssociationOwner', Owner) then",
    "      RaiseException('Could not persist pending association owner.');",
    `    if not SetPreviousData(PreviousDataKey, 'ExecutableName', '${executableLiteral}') or`,
    "       not SetPreviousData(PreviousDataKey, 'InstallDir', ExpandConstant('{app}')) then",
    "      RaiseException('Could not persist current installation identity.');",
    ...(perUser
      ? [
          "    RegisterAutostartData(PreviousDataKey);",
        ]
      : []),
    "    PendingAssociationDataSaved := True;",
    `    InstallationSnapshot.ExecutableName := '${executableLiteral}';`,
    "    InstallationSnapshot.InstallDir := ExpandConstant('{app}');",
    "    InstallationSnapshot.PendingOwner := Owner;",
    "  except",
    "    PostInstallError := GetExceptionMessage;",
    "    RaiseException(PostInstallError);",
    "  end;",
    "end;",
    "",
  );
  return lines;
}

/**
 * Renders the installer script, rejecting unsupported OS, scope and executable
 * settings before the compiler is invoked.
 */
export function renderInnoScript(options: InnoOptions): string {
  const context = createInnoContext(options, validateInnoOptions(options));
  const lines = [
    ...setupSection(context),
    ...filesSection(context),
    ...tasksSection(context),
    ...iconsSection(context),
    ...runAndDeleteSections(context),
    ...codeSupportSection(context),
    ...prepareToInstallSection(context),
    ...cleanupSection(context),
    ...installStepsSection(context),
  ];
  return `${lines.join("\n")}\n`;
}

/**
 * Prepares Inno's callback for signing and verifying embedded PE files.
 * Signing commands and credentials stay in the compiler environment rather
 * than the generated script or compiler command line.
 */
export async function prepareInnoSigning(
  ctx: StageContext,
  staging: string,
  signtool: string,
) {
  const dir = join(staging, "inno-signing");
  const callback = join(dir, "sign.js");
  await mkdir(dir, {
    recursive: true,
  });
  await writeFile(
    callback,
    `try {
  const commands = JSON.parse(process.env.BUNAWAY_INNO_SIGN_COMMANDS);
  const file = process.argv[2];
  if (!file) throw new Error();
  for (const command of commands) {
    const result = Bun.spawnSync([...command, file], { stdout: "ignore", stderr: "ignore" });
    if (result.exitCode !== 0) throw new Error();
  }
} catch {
  console.error("Inno Authenticode signing or verification failed.");
  process.exit(1);
}
`,
  );
  const quote = (value: string) => `$q${value.replace(/\$/g, () => "$$")}$q`;
  return {
    args: [
      `/Sbunaway=${quote(process.execPath)} ${quote(callback)} $f`,
    ],
    env: {
      ...process.env,
      BUNAWAY_INNO_SIGN_COMMANDS: JSON.stringify([
        [
          signtool,
          "sign",
          ...signingArgs(ctx),
        ],
        [
          signtool,
          "verify",
          "/pa",
        ],
      ]),
    },
  };
}

/**
 * Writes the generated script and invokes ISCC, returning the installer path.
 * Signing callback files are removed from staging on both success and failure.
 */
export async function compileInno(
  ctx: StageContext,
  iss: string,
  staging: string,
  outputBaseName: string,
): Promise<string> {
  const iscc = await findIscc();
  if (!iscc) {
    ctx.report({
      code: CODES.TOOL_MISSING,
      severity: "error",
      message:
        "Inno Setup compiler (ISCC.exe) not found; install Inno Setup 6.3 or newer.",
    });
    throw new Error("ISCC.exe not found.");
  }
  const issPath = join(staging, `${outputBaseName}.iss`);
  // BOM keeps Inno's Pascal parser happy with non-ASCII names.
  await writeFile(issPath, `﻿${iss}`);
  try {
    if (ctx.input.signing) {
      const signtool = await findWindowsKitTool("signtool.exe");
      if (!signtool) {
        throw new Error(
          "signtool.exe not found; cannot sign the embedded uninstaller.",
        );
      }
      const signing = await prepareInnoSigning(ctx, staging, signtool);
      await must(
        iscc,
        [
          "/Q",
          ...signing.args,
          issPath,
        ],
        {
          env: signing.env,
        },
      );
    } else {
      await must(iscc, [
        "/Q",
        issPath,
      ]);
    }
  } catch (error) {
    ctx.report({
      code: CODES.TOOL_FAILED,
      severity: "error",
      message: `Inno compile failed: ${error instanceof Error ? error.message : String(error)}`,
    });
    throw error;
  } finally {
    await rm(join(staging, "inno-signing"), {
      recursive: true,
      force: true,
    });
  }
  return join(staging, "installer", `${outputBaseName}.exe`);
}
