import type { ChannelConfig } from "../../contract.ts";
import { parseAssociations } from "../../windows-associations.ts";
import { stableGuid } from "./common.ts";
import { innoIdentity } from "./inno-identity.ts";

/** Renders app-owned registration and cleanup without assigning Windows defaults. */
export function renderAssociationCode(
  identifier: string,
  executableName: string,
  appName: string,
  declarations: ChannelConfig["associations"],
  scope: "perUser" | "perMachine",
): string {
  const config = declarations ? parseAssociations(declarations) : {};
  const root = `Software\\Bunaway\\Associations\\${stableGuid(identifier)}`;
  const literal = (value: string) => {
    if (/[\r\n\0]/.test(value)) {
      throw new Error(
        "Association values must not contain line breaks or NUL.",
      );
    }
    return value.replace(/'/g, "''");
  };
  const progId = (kind: string, value: string) =>
    `BW.${stableGuid(`${identifier}:${kind}:${value}`).replace(/-/g, "")}`;
  const entries = [
    ...(config.files ?? []).map((entry) => ({
      ...entry,
      token: entry.extension,
      kind: "FileAssociations",
      task: "fileassociations",
      progId: progId("file", entry.extension),
    })),
    ...(config.urlSchemes ?? []).map((entry) => ({
      ...entry,
      token: entry.scheme,
      kind: "UrlAssociations",
      task: "urlschemes",
      progId: progId("url", entry.scheme),
    })),
  ];
  const selectedTasks = [
    ...new Set(entries.map((entry) => entry.task)),
  ]
    .map((task) => `WizardIsTaskSelected('${task}')`)
    .join(" or ");
  const preflight = entries
    .map(
      (entry) => `  if WizardIsTaskSelected('${entry.task}') then
    CheckAssociationCandidate('${entry.progId}');`,
    )
    .join("\n");
  const registration = entries
    .map(
      (entry) => `
  if WizardIsTaskSelected('${entry.task}') then begin
    RegisterAssociation('${entry.kind}', '${literal(entry.token)}', '${entry.progId}', '${literal(entry.name)}', ${entry.kind === "UrlAssociations" ? "True" : "False"});
    ${
      "mimeType" in entry && entry.mimeType
        ? `WriteAssociationValue('Software\\Classes\\${entry.progId}', 'Content Type', '${literal(entry.mimeType)}');
    WriteAssociationValue(AssociationRoot + '\\Capabilities\\MIMEAssociations', '${literal(entry.mimeType)}', '${entry.progId}');`
        : ""
    }
  end;`,
    )
    .join("\n");
  return String.raw`
// Only application-owned candidates are managed. Extension defaults, protocol
// defaults and Windows UserChoice values are never written or removed.
const AssociationHive = ${scope === "perUser" ? "HKCU" : "HKLM"};
      AssociationRoot = '${root}';
      AssociationRegistration = '${literal(`${appName} (${identifier})`)}';
      AssociationPreviousDataKey = '${innoIdentity(identifier).previousDataKey}';

// Inno's Boolean registry helpers conflate absence with access/I/O failure.
// Probe native status codes before allowing absence to authorize recovery.
const ASSOCIATION_REG_SUCCESS = 0;
      ASSOCIATION_REG_NOT_FOUND = 2;
      ASSOCIATION_REG_PATH_NOT_FOUND = 3;
      ASSOCIATION_REG_QUERY_VALUE = 1;
      ASSOCIATION_REG_VIEW_64 = 256;
      ASSOCIATION_REG_VIEW_32 = 512;

// Inno 6.7 scripts are 32-bit even in 64-bit installation mode. Registry handles
// and null pointers use supported 32-bit types; the explicit view matches Inno.
function OpenAssociationRegistryKey(Hive: LongWord; Key: String; Options, Access: LongWord; var Handle: LongWord): Integer;
  external 'RegOpenKeyExW@advapi32.dll stdcall';
function ProbeAssociationRegistryValue(Handle: LongWord; Name: String; Reserved, ValueType, Data: LongWord; var DataBytes: LongWord): Integer;
  external 'RegQueryValueExW@advapi32.dll stdcall';
function CloseAssociationRegistryKey(Handle: LongWord): Integer;
  external 'RegCloseKey@advapi32.dll stdcall';

function OpenAssociationKey(const Key: String; var Handle: LongWord): Integer;
var View: LongWord;
begin
  if Is64BitInstallMode then View := ASSOCIATION_REG_VIEW_64
  else View := ASSOCIATION_REG_VIEW_32;
  Result := OpenAssociationRegistryKey(AssociationHive, Key, 0,
    ASSOCIATION_REG_QUERY_VALUE or View, Handle);
end;

function IsAbsentAssociationKey(Status: Integer): Boolean;
begin
  Result := (Status = ASSOCIATION_REG_NOT_FOUND) or
    (Status = ASSOCIATION_REG_PATH_NOT_FOUND);
end;

function AssociationKeyExists(const Key: String): Boolean;
var Handle: LongWord; Status: Integer;
begin
  Status := OpenAssociationKey(Key, Handle);
  Result := Status = ASSOCIATION_REG_SUCCESS;
  if Result then CloseAssociationRegistryKey(Handle)
  else if not IsAbsentAssociationKey(Status) then
    RaiseException('Could not inspect app association key: ' + Key + ' (error ' + IntToStr(Status) + ')');
end;

function AssociationValueExists(const Key, Name: String): Boolean;
var Handle, DataBytes: LongWord; Status: Integer;
begin
  Result := False;
  Status := OpenAssociationKey(Key, Handle);
  if IsAbsentAssociationKey(Status) then Exit;
  if Status <> ASSOCIATION_REG_SUCCESS then
    RaiseException('Could not inspect app association key: ' + Key + ' (error ' + IntToStr(Status) + ')');
  try
    DataBytes := 0;
    Status := ProbeAssociationRegistryValue(Handle, Name, 0, 0, 0, DataBytes);
    Result := Status = ASSOCIATION_REG_SUCCESS;
    if not Result and (Status <> ASSOCIATION_REG_NOT_FOUND) then
      RaiseException('Could not inspect app association value: ' + Key + ' (error ' + IntToStr(Status) + ')');
  finally
    CloseAssociationRegistryKey(Handle);
  end;
end;

function QueryAssociationValue(const Key, Name: String; var Value: String): Boolean;
begin
  Result := AssociationValueExists(Key, Name);
  if Result and not RegQueryStringValue(AssociationHive, Key, Name, Value) then
    RaiseException('Could not read app association value: ' + Key);
end;

function GetAssociationValueNames(const Key: String; var Names: TArrayOfString): Boolean;
begin
  Result := RegGetValueNames(AssociationHive, Key, Names);
  if not Result and AssociationKeyExists(Key) then
    RaiseException('Could not enumerate app association values: ' + Key);
end;

function AssociationExecutable: String;
begin
  Result := ExpandConstant('{app}') + '\' + '${literal(executableName)}';
end;

function AssociationCommand(const Executable: String): String;
begin
  Result := '"' + Executable + '" "%1"';
end;

function IsAssociationProgId(const Value: String): Boolean;
var I: Integer;
begin
  Result := False;
  if (Length(Value) <> 35) or (Copy(Value, 1, 3) <> 'BW.') then Exit;
  for I := 4 to Length(Value) do
    if Pos(Lowercase(Value[I]), '0123456789abcdef') = 0 then Exit;
  Result := True;
end;

procedure WriteAssociationValue(const Key, Name, Value: String);
begin
  if not RegWriteStringValue(AssociationHive, Key, Name, Value) then
    RaiseException('Could not register app association: ' + Key);
end;

procedure DeleteAssociationValue(const Key, Name: String);
begin
  if AssociationValueExists(Key, Name) and
     not RegDeleteValue(AssociationHive, Key, Name) then
    RaiseException('Could not remove app association value: ' + Key);
end;

procedure DeleteAssociationKey(const Key: String);
begin
  if AssociationKeyExists(Key) and
     not RegDeleteKeyIncludingSubkeys(AssociationHive, Key) then
    RaiseException('Could not remove app association key: ' + Key);
end;

// The journal records absent registrations and authenticated candidates before
// destructive cleanup. A present command always wins over recovery authority.
function IsAssociationCandidateOwner(const ProgId, Executable: String): Boolean;
var Key, Command, PendingOwner, Owner: String;
begin
  Key := 'Software\Classes\' + ProgId + '\shell\open\command';
  if QueryAssociationValue(Key, '', Command) then begin
    Result := CompareText(Command, AssociationCommand(Executable)) = 0;
    Exit;
  end;
  Result := not AssociationValueExists(Key, '') and
    QueryAssociationValue(AssociationRoot + '\PendingCandidates', ProgId, PendingOwner) and
    (CompareText(PendingOwner, Executable) = 0) and
    QueryAssociationValue(AssociationRoot, 'Executable', Owner) and
    (CompareText(Owner, Executable) = 0);
end;

procedure RemoveAssociationKind(const Kind, Executable: String);
var Names: TArrayOfString; I: Integer; ProgId, Key, Extension, Value: String;
begin
  Key := AssociationRoot + '\Capabilities\' + Kind;
  if not GetAssociationValueNames(Key, Names) then Exit;
  for I := 0 to GetArrayLength(Names) - 1 do begin
    if QueryAssociationValue(Key, Names[I], ProgId) and IsAssociationProgId(ProgId) and
       IsAssociationCandidateOwner(ProgId, Executable) then begin
      // Persist ownership before recursive deletion can remove its command first.
      WriteAssociationValue(AssociationRoot + '\PendingCandidates', ProgId, Executable);
      if Kind = 'FileAssociations' then begin
        Extension := Names[I];
        // Values come from the registry, not just the validated config.
        if (Length(Extension) > 1) and (Length(Extension) <= 33) and
           (Extension[1] = '.') and (Pos('\', Extension) = 0) and (Pos('/', Extension) = 0) then begin
          if QueryAssociationValue('Software\Classes\' + Extension + '\OpenWithProgids', ProgId, Value) and (Value = '') then
            DeleteAssociationValue('Software\Classes\' + Extension + '\OpenWithProgids', ProgId);
          // Shared keys are retained if they contain defaults or other handlers.
          if not RegDeleteKeyIfEmpty(AssociationHive, 'Software\Classes\' + Extension + '\OpenWithProgids') then
            Log('Retained shared OpenWith key: ' + Extension);
          if not RegDeleteKeyIfEmpty(AssociationHive, 'Software\Classes\' + Extension) then
            Log('Retained shared extension key: ' + Extension);
        end;
      end;
      DeleteAssociationKey('Software\Classes\' + ProgId);
      DeleteAssociationValue(AssociationRoot + '\PendingCandidates', ProgId);
    end;
  end;
end;

procedure RemovePendingAssociationCandidates(const Executable: String);
var Names: TArrayOfString; I: Integer;
begin
  // Registration may fail even before a Capabilities mapping is written.
  if not GetAssociationValueNames(AssociationRoot + '\PendingCandidates', Names) then Exit;
  for I := 0 to GetArrayLength(Names) - 1 do
    if IsAssociationProgId(Names[I]) and IsAssociationCandidateOwner(Names[I], Executable) then begin
      // Retain the journal if any descendant prevents complete recursive deletion.
      WriteAssociationValue(AssociationRoot + '\PendingCandidates', Names[I], Executable);
      DeleteAssociationKey('Software\Classes\' + Names[I]);
      DeleteAssociationValue(AssociationRoot + '\PendingCandidates', Names[I]);
    end;
end;

procedure RemoveAssociations(const Executable: String);
var Owner, Registration, RegistrationName: String;
begin
  if not QueryAssociationValue(AssociationRoot, 'Executable', Owner) or
     (CompareText(Owner, Executable) <> 0) then Exit;
  RemoveAssociationKind('FileAssociations', Executable);
  RemoveAssociationKind('UrlAssociations', Executable);
  RemovePendingAssociationCandidates(Executable);
  if QueryAssociationValue(AssociationRoot, 'RegistrationName', RegistrationName) and
     QueryAssociationValue('Software\RegisteredApplications', RegistrationName, Registration) and
     (Registration = AssociationRoot + '\Capabilities') then
    DeleteAssociationValue('Software\RegisteredApplications', RegistrationName);
  DeleteAssociationKey(AssociationRoot);
end;

// Validate the entire selected snapshot before deleting any prior registration.
// Old and pending executables are trusted only through Inno's previous data.
function IsAssociationOwner(const Executable: String): Boolean;
begin
  Result := CompareText(Executable, AssociationExecutable) = 0;
  if not Result and (PreviousInstallDir <> '') and (PreviousExecutableName <> '') then
    Result := CompareText(Executable, AddBackslash(PreviousInstallDir) + PreviousExecutableName) = 0;
  if not Result and (PendingAssociationInstallDir <> '') and (PendingAssociationExecutableName <> '') then
    Result := CompareText(Executable, AddBackslash(PendingAssociationInstallDir) + PendingAssociationExecutableName) = 0;
end;

procedure CheckAssociationCandidate(const ProgId: String);
var Key: String;
begin
  Key := 'Software\Classes\' + ProgId;
  if not AssociationKeyExists(Key) then Exit;
  if not (IsAssociationCandidateOwner(ProgId, AssociationExecutable) or
          ((PreviousInstallDir <> '') and (PreviousExecutableName <> '') and
           IsAssociationCandidateOwner(ProgId, AddBackslash(PreviousInstallDir) + PreviousExecutableName)) or
          ((PendingAssociationInstallDir <> '') and (PendingAssociationExecutableName <> '') and
           IsAssociationCandidateOwner(ProgId, AddBackslash(PendingAssociationInstallDir) + PendingAssociationExecutableName))) then
    RaiseException('App association is owned by a different command: ' + ProgId);
end;

procedure PreflightAssociations;
var Owner, Registration: String;
begin
  ${selectedTasks ? `if not (${selectedTasks}) then Exit;` : "Exit;"}
  if AssociationKeyExists(AssociationRoot) and
     (not QueryAssociationValue(AssociationRoot, 'Executable', Owner) or
      not IsAssociationOwner(Owner)) then
    RaiseException('App associations belong to another installation.');
  if QueryAssociationValue('Software\RegisteredApplications', AssociationRegistration, Registration) and
     (Registration <> AssociationRoot + '\Capabilities') then
    RaiseException('App registration belongs to another installation.');
${preflight}
end;

procedure RegisterAssociation(const Kind, Token, ProgId, Name: String; Protocol: Boolean);
var Key: String;
begin
  Key := 'Software\Classes\' + ProgId;
  if AssociationKeyExists(Key) then begin
    if not IsAssociationCandidateOwner(ProgId, AssociationExecutable) then
      RaiseException('App association is owned by a different command: ' + ProgId);
  end else
    WriteAssociationValue(AssociationRoot + '\PendingCandidates', ProgId, AssociationExecutable);
  WriteAssociationValue(AssociationRoot + '\Capabilities\' + Kind, Token, ProgId);
  WriteAssociationValue(Key, '', Name);
  WriteAssociationValue(Key + '\DefaultIcon', '', '"' + AssociationExecutable + '",0');
  WriteAssociationValue(Key + '\shell\open\command', '', AssociationCommand(AssociationExecutable));
  if Protocol then WriteAssociationValue(Key, 'URL Protocol', '');
  if Kind = 'FileAssociations' then
    WriteAssociationValue('Software\Classes\' + Token + '\OpenWithProgids', ProgId, '');
  DeleteAssociationValue(AssociationRoot + '\PendingCandidates', ProgId);
end;

procedure RemovePendingAssociationOwner;
begin
  if (PendingAssociationInstallDir <> '') and (PendingAssociationExecutableName <> '') then
    RemoveAssociations(AddBackslash(PendingAssociationInstallDir) + PendingAssociationExecutableName);
end;

procedure ClearPendingAssociationOwner;
begin
  // Inno closes RegisterPreviousData's handle before ssPostInstall. Reopen
  // this install's own key instead of retaining or reusing that handle.
  WriteAssociationValue(AssociationPreviousDataKey, 'Inno Setup CodeFile: PendingAssociationOwner', '');
  InstallationSnapshot.PendingOwner := '';
  PendingAssociationExecutableName := '';
  PendingAssociationInstallDir := '';
end;

procedure InstallAssociations;
var Owner: String;
begin
  PreflightAssociations;
  // Installers without uninstall info do not run RegisterPreviousData.
  // No selected candidate and no prior snapshot means there is nothing to persist.
  if ${selectedTasks ? `not (${selectedTasks}) and ` : ""}not AssociationKeyExists(AssociationRoot) then Exit;
  if not PendingAssociationDataSaved then
    RaiseException('Could not persist pending association owner.');
  // Updates remove the previous snapshot, including declarations no longer
  // present. Ownership checks retain entries changed to another command.
  RemovePendingAssociationOwner;
  if (PreviousInstallDir <> '') and (PreviousExecutableName <> '') then
    RemoveAssociations(AddBackslash(PreviousInstallDir) + PreviousExecutableName);
  RemoveAssociations(AssociationExecutable);
  ${
    entries.length
      ? `if ${[
          ...(config.files
            ? [
                "WizardIsTaskSelected('fileassociations')",
              ]
            : []),
          ...(config.urlSchemes
            ? [
                "WizardIsTaskSelected('urlschemes')",
              ]
            : []),
        ].join(" or ")} then begin
    if AssociationKeyExists(AssociationRoot) then begin
      if not QueryAssociationValue(AssociationRoot, 'Executable', Owner) or
         (CompareText(Owner, AssociationExecutable) <> 0) then
        RaiseException('App associations belong to another installation.');
    end;
    WriteAssociationValue(AssociationRoot, 'Executable', AssociationExecutable);
    WriteAssociationValue(AssociationRoot, 'RegistrationName', AssociationRegistration);
    WriteAssociationValue(AssociationRoot + '\\Capabilities', 'ApplicationName', AssociationRegistration);
    WriteAssociationValue(AssociationRoot + '\\Capabilities', 'ApplicationDescription', '${literal(appName)}');
    WriteAssociationValue('Software\\RegisteredApplications', AssociationRegistration, AssociationRoot + '\\Capabilities');
${registration}
  end;`
      : ""
  }
end;
`;
}
