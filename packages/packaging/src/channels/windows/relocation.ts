/** File name of the payload list that Setup unpacks to remove a relocated installation. */
export const RELOCATION_PAYLOAD_LIST = "payload-files.txt";

/**
 * Pascal support for installing into a folder other than the previous one.
 *
 * Inno overwrites its uninstall record on every install, so the previous folder is
 * unknown to the new uninstaller. Setup removes it only after the new installation,
 * associations and shortcuts succeeded, and only the files this app ships:
 * the executable, the uninstaller named by the previous record, and the files in the
 * payload list. It never runs the old uninstaller (the maintenance mutex this Setup holds
 * would make it fail, and it would delete user data for installs that do not preserve it)
 * and never deletes recursively. Emit the procedures after the shared cleanup helpers.
 */
export function renderRelocationCode(options: {
  scope: "perUser" | "perMachine";
  startMenuShortcut: boolean;
  hasPayloadList: boolean;
}) {
  const perMachine = options.scope === "perMachine";
  return {
    declarations: `
var RelocationAppPath: String;
    RelocationUninstallString: String;
    RelocationPendingUninstaller: String;
    RelocationRecordLoaded: Boolean;
    RelocationShortcutFailed: Boolean;
`,
    procedures: String.raw`
function GetRelocationDriveType(RootPath: String): LongWord;
  external 'GetDriveTypeW@kernel32.dll stdcall';

// The previous Inno record is read before Setup rewrites it. The old folder and its payload are
// trusted from this app's own CodeFile record (or the pending predecessor it wrote). The Inno
// values only authorize deleting the old uninstaller, and then only when they name that same folder.
function ReadRelocationRecord(var AppPath, UninstallString, PendingUninstaller: String): Boolean;
begin
  Result := False;
  AppPath := '';
  UninstallString := '';
  PendingUninstaller := '';
  try
    QueryAssociationValue(AssociationPreviousDataKey, 'Inno Setup: App Path', AppPath);
    QueryAssociationValue(AssociationPreviousDataKey, 'UninstallString', UninstallString);
    QueryAssociationValue(AssociationPreviousDataKey, 'Inno Setup CodeFile: PendingUninstaller', PendingUninstaller);
    Result := True;
  except
    Log('Could not read the previous installation record: ' + GetExceptionMessage);
  end;
end;

procedure CaptureRelocationRecord;
begin
  RelocationRecordLoaded := ReadRelocationRecord(RelocationAppPath, RelocationUninstallString, RelocationPendingUninstaller);
end;

procedure ValidateRelocationRecord;
var AppPath, UninstallString, PendingUninstaller: String;
begin
  if not RelocationRecordLoaded then Exit;
  if not ReadRelocationRecord(AppPath, UninstallString, PendingUninstaller) or
     (AppPath <> RelocationAppPath) or (UninstallString <> RelocationUninstallString) or
     (PendingUninstaller <> RelocationPendingUninstaller) then
    RaiseException('Installation state changed while this setup was open. Close it and start again.');
end;

function IsSameDirectory(const First, Second: String): Boolean;
begin
  Result := CompareText(AddBackslash(First), AddBackslash(Second)) = 0;
end;

function IsNestedDirectory(const Parent, Child: String): Boolean;
begin
  Result := Pos(Lowercase(AddBackslash(Parent)), Lowercase(AddBackslash(Child))) = 1;
end;

function IsRelocation: Boolean;
begin
  Result := (PreviousExecutableName <> '') and (PreviousInstallDir <> '') and
    not IsSameDirectory(PreviousInstallDir, ExpandConstant('{app}'));
end;

function IsUninstallerFileName(const Name: String): Boolean;
begin
  Result := (Length(Name) = 12) and (CompareText(Copy(Name, 1, 5), 'unins') = 0) and
    (CompareText(Copy(Name, 9, 4), '.exe') = 0) and
    (Pos(Name[6], '0123456789') > 0) and (Pos(Name[7], '0123456789') > 0) and
    (Pos(Name[8], '0123456789') > 0);
end;

function IsUninstallerIn(const Path, Dir: String): Boolean;
begin
  Result := (Path <> '') and IsSameDirectory(ExtractFilePath(Path), Dir) and
    IsUninstallerFileName(ExtractFileName(Path));
end;

// The uninstaller is trusted only when the previous Inno record names it inside the folder
// that record installed to, or when an earlier attempt of this relocation saved that same path
// (a failed attempt leaves Inno's own record pointing at the new folder).
function RelocationUninstallerPath(const Dir: String): String;
var Path: String;
begin
  Result := '';
  Path := RemoveQuotes(RelocationUninstallString);
  if (RelocationAppPath <> '') and IsSameDirectory(RelocationAppPath, Dir) and IsUninstallerIn(Path, Dir) then
    Result := Path
  else if IsUninstallerIn(RelocationPendingUninstaller, Dir) then
    Result := RelocationPendingUninstaller;
end;

// Keeps the old uninstaller known until the cleanup finishes; the value is cleared with the
// pending predecessor.
procedure SaveRelocationPendingUninstaller(PreviousDataKey: Integer);
var Path: String;
begin
  Path := '';
  if IsRelocation then Path := RelocationUninstallerPath(PreviousInstallDir);
  if (Path = '') and (PendingAssociationExecutableName <> '') then Path := RelocationPendingUninstaller;
  if not SetPreviousData(PreviousDataKey, 'PendingUninstaller', Path) then
    RaiseException('Could not persist the previous uninstaller.');
end;

procedure ClearRelocationPendingUninstaller;
begin
  WriteAssociationValue(AssociationPreviousDataKey, 'Inno Setup CodeFile: PendingUninstaller', '');
end;

function IsProtectedRelocationDirectory(const Dir: String): Boolean;
var Profile: String;
begin
  Profile := GetEnv('USERPROFILE');
  Result := IsSameDirectory(Dir, ExtractFileDrive(Dir)) or
    IsSameDirectory(Dir, ExpandConstant('{userdesktop}')) or
    IsSameDirectory(Dir, ExpandConstant('{commondesktop}')) or
    IsSameDirectory(Dir, ExtractFileDir(ExpandConstant('{commondesktop}'))) or
    IsSameDirectory(Dir, ExpandConstant('{userdocs}')) or
    IsSameDirectory(Dir, ExpandConstant('{commondocs}')) or
    IsSameDirectory(Dir, ExpandConstant('{userappdata}')) or
    IsSameDirectory(Dir, ExpandConstant('{commonappdata}')) or
    IsSameDirectory(Dir, ExpandConstant('{autopf}')) or
    IsSameDirectory(Dir, ExpandConstant('{commonpf}')) or
    IsSameDirectory(Dir, ExpandConstant('{commonpf32}')) or
    IsSameDirectory(Dir, ExpandConstant('{localappdata}')) or
    IsSameDirectory(Dir, ExpandConstant('{localappdata}') + '\Programs') or
    IsSameDirectory(Dir, ExpandConstant('{win}')) or
    IsSameDirectory(Dir, ExpandConstant('{sys}')) or
    ((Profile <> '') and (IsSameDirectory(Dir, Profile) or
      IsSameDirectory(Dir, Profile + '\Downloads') or
      IsSameDirectory(Dir, Profile + '\Music') or
      IsSameDirectory(Dir, Profile + '\Pictures') or
      IsSameDirectory(Dir, Profile + '\Videos') or
      IsSameDirectory(Dir, ExtractFileDir(Profile))));
end;

// A folder is removed only when it is a local, unrelated-to-the-new-folder directory
// reached without links.${
      perMachine
        ? `
// A per-machine installation is removed only below Program Files: a folder that ordinary users
// can write could be swapped for a link between this check and the deletes.`
        : ""
    }
function IsSafeRelocationSource(const Dir: String): Boolean;
begin
  Result := False;
  if (Length(Dir) < 4) or (Dir[2] <> ':') or (Dir[3] <> '\') then Exit;
  // DRIVE_FIXED: a network, removable or optical drive is never cleaned up.
  if GetRelocationDriveType(Copy(Dir, 1, 3)) <> 3 then Exit;
  if IsNestedDirectory(Dir, ExpandConstant('{app}')) or
     IsNestedDirectory(ExpandConstant('{app}'), Dir) then Exit;
  // A shell folder that cannot be resolved (service account, unreachable redirected folder)
  // counts as protected: keeping the old folder is the safe outcome.
  try
    if IsProtectedRelocationDirectory(Dir) then Exit;
  except
    Log('Kept the previous installation folder, a system folder could not be resolved: ' + GetExceptionMessage);
    Exit;
  end;${
    perMachine
      ? `
  if not IsNestedDirectory(ExpandConstant('{commonpf}'), Dir) then Exit;`
      : ""
  }
  Result := IsPlainDirectoryChain(Dir);
end;

procedure DeleteRelocationFile(const Path: String; var Failed: Integer);
var Entry: TFindRec;
begin
  if not FindFirst(Path, Entry) then Exit;
  try
    if (Entry.Attributes and (FILE_ATTRIBUTE_DIRECTORY or FILE_ATTRIBUTE_REPARSE_POINT)) <> 0 then Exit;
  finally FindClose(Entry); end;
  if not DeleteFile(Path) then begin
    Log('Could not remove previous installation file: ' + Path);
    Failed := Failed + 1;
  end;
end;

function IsRelocationPayloadEntry(const Relative: String): Boolean;
begin
  Result := (Relative <> '') and (Relative[1] <> '\') and (Pos(':', Relative) = 0) and (Pos('..', Relative) = 0);
end;

// Strings cannot tell that a junction, a subst drive or a different letter case names the new
// folder. Write a probe into the new folder and look for it in the old one: if it shows up, both
// paths are one folder and nothing may be removed. When the probe cannot be written, assume so.
function IsNewFolderOnDisk(const Dir: String): Boolean;
var ProbeName, Probe: String;
begin
  Result := True;
  ProbeName := '.relocation-' + ExtractFileName(ExpandConstant('{tmp}'));
  Probe := ExpandConstant('{app}') + '\' + ProbeName;
  if not SaveStringToFile(Probe, 'probe', False) then Exit;
  try
    Result := FileExists(Dir + '\' + ProbeName);
  finally
    DeleteFile(Probe);
  end;
end;

// Files first, then parent folders deepest first. RemoveDir fails on a non-empty folder,
// which keeps anything the user added.
procedure RemoveRelocationPayload(const Dir: String; Payload: TStringList; var Failed: Integer);
var I: Integer; Relative, Parent, CheckedParent: String;
begin
  CheckedParent := '';
  for I := 0 to Payload.Count - 1 do begin
    Relative := Trim(Payload[I]);
    if not IsRelocationPayloadEntry(Relative) then Continue;
    Parent := ExtractFileDir(Dir + '\' + Relative);
    if CompareText(Parent, CheckedParent) <> 0 then begin
      if not IsPlainDirectoryChain(Parent) then Continue;
      CheckedParent := Parent;
    end;
    DeleteRelocationFile(Dir + '\' + Relative, Failed);
  end;
  for I := Payload.Count - 1 downto 0 do begin
    Relative := Trim(Payload[I]);
    if not IsRelocationPayloadEntry(Relative) then Continue;
    Parent := ExtractFileDir(Dir + '\' + Relative);
    while (Length(Parent) > Length(Dir)) and IsPlainDirectoryChain(Parent) and RemoveDir(Parent) do
      Parent := ExtractFileDir(Parent);
  end;
end;

// Payload may be nil (uninstall cannot unpack the list); the executable is always removed.
procedure RemoveRelocatedInstallation(const ExecutableName, Dir: String; Payload: TStringList);
var Failed: Integer; Uninstaller: String;
begin
  if not IsSafeExecutableName(ExecutableName) or (Dir = '') or
     IsSameDirectory(Dir, ExpandConstant('{app}')) then Exit;
  if not IsSafeRelocationSource(Dir) then begin
    Log('Kept the previous installation folder: ' + Dir);
    Exit;
  end;
  if IsNewFolderOnDisk(Dir) then begin
    Log('Kept the previous installation folder, it is the new installation folder: ' + Dir);
    Exit;
  end;
  Failed := 0;
  Uninstaller := RelocationUninstallerPath(Dir);
  if Uninstaller <> '' then begin
    DeleteRelocationFile(Uninstaller, Failed);
    DeleteRelocationFile(ChangeFileExt(Uninstaller, '.dat'), Failed);
    DeleteRelocationFile(ChangeFileExt(Uninstaller, '.msg'), Failed);
  end;
  if Payload <> nil then RemoveRelocationPayload(Dir, Payload, Failed);
  DeleteRelocationFile(Dir + '\' + ExecutableName, Failed);
  RemoveDir(Dir);
  if Failed > 0 then
    RaiseException('Could not remove the previous installation in ' + Dir + '. Run the installer again after closing the app.');
end;

procedure RemoveRelocatedInstallationWithPayload;
var Payload: TStringList;
begin
  if not IsRelocation then Exit;
  if RelocationShortcutFailed then
    RaiseException('Could not update a shortcut to the new executable (see the setup log for its path). Repair or delete that shortcut and run the installer again to finish removing the previous installation.');
  Payload := nil;
  try${
    options.hasPayloadList
      ? `
    Payload := TStringList.Create;
    ExtractTemporaryFile('${RELOCATION_PAYLOAD_LIST}');
    Payload.LoadFromFile(ExpandConstant('{tmp}\\${RELOCATION_PAYLOAD_LIST}'));`
      : ""
  }
    RemoveRelocatedInstallation(PreviousExecutableName, PreviousInstallDir, Payload);
  finally
    if Payload <> nil then Payload.Free;
  end;
end;
${
  options.startMenuShortcut
    ? `
// Inno keeps an existing uninstall link, so it still points at the previous uninstaller.
procedure UpdateUninstallShortcut(const Filename: String);
var Link: Variant; Target, Expected: String;
begin
  if not IsRelocation then Exit;
  Expected := RelocationUninstallerPath(PreviousInstallDir);
  if Expected = '' then Exit;
  if not ReadShortcut(Filename, Link, Target) then Exit;
  if CompareText(Target, Expected) <> 0 then Exit;
  try
    Link.Path := ExpandConstant('{uninstallexe}');
    Link.Save(Filename);
  except
    Log('Could not update uninstall shortcut: ' + Filename);
    RelocationShortcutFailed := True;
  end;
end;
`
    : ""
}`,
  };
}
