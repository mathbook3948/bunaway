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
  if RegValueExists(AssociationHive, Key, Name) and
     not RegDeleteValue(AssociationHive, Key, Name) then
    RaiseException('Could not remove app association value: ' + Key);
end;

procedure DeleteAssociationKey(const Key: String);
begin
  if RegKeyExists(AssociationHive, Key) and
     not RegDeleteKeyIncludingSubkeys(AssociationHive, Key) then
    RaiseException('Could not remove app association key: ' + Key);
end;

// The journal is written only for absent candidates before any ProgID writes.
// A present command always wins: recovery never claims a foreign replacement.
function IsAssociationCandidateOwner(const ProgId, Executable: String): Boolean;
var Key, Command, PendingOwner, Owner: String;
begin
  Key := 'Software\Classes\' + ProgId + '\shell\open\command';
  if RegQueryStringValue(AssociationHive, Key, '', Command) then begin
    Result := CompareText(Command, AssociationCommand(Executable)) = 0;
    Exit;
  end;
  Result := not RegValueExists(AssociationHive, Key, '') and
    RegQueryStringValue(AssociationHive, AssociationRoot + '\PendingCandidates', ProgId, PendingOwner) and
    (CompareText(PendingOwner, Executable) = 0) and
    RegQueryStringValue(AssociationHive, AssociationRoot, 'Executable', Owner) and
    (CompareText(Owner, Executable) = 0);
end;

procedure RemoveAssociationKind(const Kind, Executable: String);
var Names: TArrayOfString; I: Integer; ProgId, Key, Extension, Value: String;
begin
  Key := AssociationRoot + '\Capabilities\' + Kind;
  if not RegGetValueNames(AssociationHive, Key, Names) then Exit;
  for I := 0 to GetArrayLength(Names) - 1 do begin
    if RegQueryStringValue(AssociationHive, Key, Names[I], ProgId) and IsAssociationProgId(ProgId) and
       IsAssociationCandidateOwner(ProgId, Executable) then begin
      if Kind = 'FileAssociations' then begin
        Extension := Names[I];
        // Values come from the registry, not just the validated config.
        if (Length(Extension) > 1) and (Length(Extension) <= 33) and
           (Extension[1] = '.') and (Pos('\', Extension) = 0) and (Pos('/', Extension) = 0) then begin
          if RegQueryStringValue(AssociationHive, 'Software\Classes\' + Extension + '\OpenWithProgids', ProgId, Value) and (Value = '') then
            DeleteAssociationValue('Software\Classes\' + Extension + '\OpenWithProgids', ProgId);
          // Shared keys are retained if they contain defaults or other handlers.
          if not RegDeleteKeyIfEmpty(AssociationHive, 'Software\Classes\' + Extension + '\OpenWithProgids') then
            Log('Retained shared OpenWith key: ' + Extension);
          if not RegDeleteKeyIfEmpty(AssociationHive, 'Software\Classes\' + Extension) then
            Log('Retained shared extension key: ' + Extension);
        end;
      end;
      DeleteAssociationKey('Software\Classes\' + ProgId);
    end;
  end;
end;

procedure RemovePendingAssociationCandidates(const Executable: String);
var Names: TArrayOfString; I: Integer;
begin
  // Registration may fail even before a Capabilities mapping is written.
  if not RegGetValueNames(AssociationHive, AssociationRoot + '\PendingCandidates', Names) then Exit;
  for I := 0 to GetArrayLength(Names) - 1 do
    if IsAssociationProgId(Names[I]) and IsAssociationCandidateOwner(Names[I], Executable) then
      DeleteAssociationKey('Software\Classes\' + Names[I]);
end;

procedure RemoveAssociations(const Executable: String);
var Owner, Registration, RegistrationName: String;
begin
  if not RegQueryStringValue(AssociationHive, AssociationRoot, 'Executable', Owner) or
     (CompareText(Owner, Executable) <> 0) then Exit;
  RemoveAssociationKind('FileAssociations', Executable);
  RemoveAssociationKind('UrlAssociations', Executable);
  RemovePendingAssociationCandidates(Executable);
  if RegQueryStringValue(AssociationHive, AssociationRoot, 'RegistrationName', RegistrationName) and
     RegQueryStringValue(AssociationHive, 'Software\RegisteredApplications', RegistrationName, Registration) and
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
  if not RegKeyExists(AssociationHive, Key) then Exit;
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
  if RegKeyExists(AssociationHive, AssociationRoot) and
     (not RegQueryStringValue(AssociationHive, AssociationRoot, 'Executable', Owner) or
      not IsAssociationOwner(Owner)) then
    RaiseException('App associations belong to another installation.');
  if RegQueryStringValue(AssociationHive, 'Software\RegisteredApplications', AssociationRegistration, Registration) and
     (Registration <> AssociationRoot + '\Capabilities') then
    RaiseException('App registration belongs to another installation.');
${preflight}
end;

procedure RegisterAssociation(const Kind, Token, ProgId, Name: String; Protocol: Boolean);
var Key: String;
begin
  Key := 'Software\Classes\' + ProgId;
  if RegKeyExists(AssociationHive, Key) then begin
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
  PendingAssociationExecutableName := '';
  PendingAssociationInstallDir := '';
end;

procedure InstallAssociations;
var Owner: String;
begin
  PreflightAssociations;
  // Installers without uninstall info do not run RegisterPreviousData.
  // No selected candidate and no prior snapshot means there is nothing to persist.
  if ${selectedTasks ? `not (${selectedTasks}) and ` : ""}not RegKeyExists(AssociationHive, AssociationRoot) then begin
    if PendingAssociationDataSaved then ClearPendingAssociationOwner;
    Exit;
  end;
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
    if RegKeyExists(AssociationHive, AssociationRoot) then begin
      if not RegQueryStringValue(AssociationHive, AssociationRoot, 'Executable', Owner) or
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
  ClearPendingAssociationOwner;
end;
`;
}
