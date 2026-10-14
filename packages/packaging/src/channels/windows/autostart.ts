import { AUTOSTART_ARGUMENT } from "@bunaway/protocol";

/**
 * Manages only packaged Run values whose quoted executable matches this install
 * or its persisted predecessor. StartupApproved is deliberately never changed.
 * Emit after installation state and IsSafeExecutableName definitions.
 */
export function renderAutostartCode(appId: string, offerTask: boolean): string {
  if (!/^[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/.test(appId)) {
    throw new Error("Invalid installer autostart app identifier.");
  }
  return String.raw`
const AutostartAppId = '${appId}';
      AutostartRunKey = 'Software\Microsoft\Windows\CurrentVersion\Run';
      AUTOSTART_MAX_COMMAND_LENGTH = 260;

type TAutostartOwner = record
  AppId: String;
  Executable: String;
end;
var PreviousAutostartOwner, PendingAutostartOwner: TAutostartOwner;
    AutostartDataSaved: Boolean;

function IsAutostartAppId(const Id: String): Boolean;
var I: Integer;
begin
  Result := False;
  if (Length(Id) = 0) or (Length(Id) > 64) then Exit;
  for I := 1 to Length(Id) do
    if Pos(Id[I], 'abcdefghijklmnopqrstuvwxyz0123456789.-') = 0 then Exit;
  if (Pos(Id[1], '.-') > 0) or (Pos(Id[Length(Id)], '.-') > 0) then Exit;
  Result := True;
end;

function AutostartName(const Id: String): String;
begin
  Result := 'bunaway.packaged.' + Id;
end;

function ValidAutostartOwner(const Owner: TAutostartOwner): Boolean;
var Drive: String;
begin
  Drive := ExtractFileDrive(Owner.Executable);
  Result := IsAutostartAppId(Owner.AppId) and (Drive <> '') and
    (Pos('"', Owner.Executable) = 0) and (Pos('|', Owner.Executable) = 0) and
    (Pos(#13, Owner.Executable) = 0) and (Pos(#10, Owner.Executable) = 0) and
    IsSafeExecutableName(ExtractFileName(Owner.Executable)) and
    (CompareText(ExpandFileName(Owner.Executable), Owner.Executable) = 0);
end;

function SameAutostartOwner(const Left, Right: TAutostartOwner): Boolean;
begin
  Result := (Left.AppId = Right.AppId) and
    (CompareText(Left.Executable, Right.Executable) = 0);
end;

function CurrentAutostartOwner: TAutostartOwner;
begin
  Result.AppId := AutostartAppId;
  Result.Executable := AssociationExecutable;
end;

procedure LoadAutostartOwners;
var Separator: Integer;
begin
  PreviousAutostartOwner.AppId := InstallationSnapshot.AutostartAppId;
  // Older installers did not record the ID. Only the current ID can be inferred.
  if PreviousAutostartOwner.AppId = '' then PreviousAutostartOwner.AppId := AutostartAppId;
  if (InstallationSnapshot.InstallDir <> '') and IsSafeExecutableName(InstallationSnapshot.ExecutableName) then
    PreviousAutostartOwner.Executable := AddBackslash(InstallationSnapshot.InstallDir) + InstallationSnapshot.ExecutableName;
  if not ValidAutostartOwner(PreviousAutostartOwner) then begin
    PreviousAutostartOwner.AppId := '';
    PreviousAutostartOwner.Executable := '';
  end;
  Separator := Pos('|', InstallationSnapshot.PendingAutostartOwner);
  if Separator > 0 then begin
    PendingAutostartOwner.AppId := Copy(InstallationSnapshot.PendingAutostartOwner, 1, Separator - 1);
    PendingAutostartOwner.Executable := Copy(InstallationSnapshot.PendingAutostartOwner, Separator + 1, MaxInt);
  end;
  if (InstallationSnapshot.PendingAutostartOwner <> '') and not ValidAutostartOwner(PendingAutostartOwner) then
    RaiseException('Could not validate pending autostart owner.');
end;

function ProbeAutostartRegistryValue(Handle: LongWord; Name: String; Reserved: LongWord; var ValueType: LongWord; Data: LongWord; var DataBytes: LongWord): Integer;
  external 'RegQueryValueExW@advapi32.dll stdcall';

// Probe status before Inno's Boolean reader: denied access or a wrong type must
// never authorize overwriting a value. Always use the plugin's HKCU 64-bit view.
function QueryAutostartCommand(const Id: String; var Command: String): Boolean;
var Handle, DataBytes, ValueType: LongWord; Status: Integer;
begin
  Result := False;
  Command := '';
  Status := OpenAssociationRegistryKey(HKCU, AutostartRunKey, 0,
    ASSOCIATION_REG_QUERY_VALUE or ASSOCIATION_REG_VIEW_64, Handle);
  if IsAbsentAssociationKey(Status) then Exit;
  if Status <> ASSOCIATION_REG_SUCCESS then
    RaiseException('Could not inspect autostart key (error ' + IntToStr(Status) + ')');
  try
    DataBytes := 0;
    Status := ProbeAutostartRegistryValue(Handle, AutostartName(Id), 0, ValueType, 0, DataBytes);
    if Status = ASSOCIATION_REG_NOT_FOUND then Exit;
    if Status <> ASSOCIATION_REG_SUCCESS then
      RaiseException('Could not inspect autostart value (error ' + IntToStr(Status) + ')');
    if ValueType <> 1 then RaiseException('Autostart command must be REG_SZ.');
    Result := True;
    if not RegQueryStringValue(HKCU64, AutostartRunKey, AutostartName(Id), Command) then
      RaiseException('Could not read autostart command.');
  finally
    CloseAssociationRegistryKey(Handle);
  end;
end;

function IsAutostartCommandOwner(const Command: String; const Owner: TAutostartOwner): Boolean;
var Prefix: String;
begin
  Result := False;
  if not ValidAutostartOwner(Owner) then Exit;
  Prefix := '"' + Owner.Executable + '"';
  if CompareText(Copy(Command, 1, Length(Prefix)), Prefix) <> 0 then Exit;
  Result := (Length(Command) = Length(Prefix)) or
    (Copy(Command, Length(Prefix) + 1, 1) = ' ');
end;

function IsKnownAutostartCommand(const Id, Command: String): Boolean;
var Current: TAutostartOwner;
begin
  Current := CurrentAutostartOwner;
  Result := ((Id = Current.AppId) and IsAutostartCommandOwner(Command, Current)) or
    ((Id = PreviousAutostartOwner.AppId) and IsAutostartCommandOwner(Command, PreviousAutostartOwner)) or
    ((Id = PendingAutostartOwner.AppId) and IsAutostartCommandOwner(Command, PendingAutostartOwner));
end;

function WantsAutostart: Boolean;
begin
  Result := ${offerTask ? "WizardIsTaskSelected('autostart')" : "False"};
end;

// Without an installer task, retain an existing runtime opt-in and relocate only
// its executable. Keep the complete encoded argument suffix, including hidden mode.
function DesiredAutostartCommand: String;
var Command: String; Owner: TAutostartOwner; I: Integer;
begin
  Result := '';
  ${offerTask ? "if not WantsAutostart then Exit;" : ""}
  for I := 0 to 2 do begin
    if I = 0 then Owner := CurrentAutostartOwner
    else if I = 1 then Owner := PreviousAutostartOwner
    else Owner := PendingAutostartOwner;
    if (Owner.AppId = AutostartAppId) and ValidAutostartOwner(Owner) and
       QueryAutostartCommand(Owner.AppId, Command) and IsAutostartCommandOwner(Command, Owner) then begin
      Result := '"' + AssociationExecutable + '"' + Copy(Command, Length(Owner.Executable) + 3, MaxInt);
      Break;
    end;
  end;
  if (Result = '') and WantsAutostart then
    Result := '"' + AssociationExecutable + '" "${AUTOSTART_ARGUMENT}"';
  if Length(Result) > AUTOSTART_MAX_COMMAND_LENGTH then
    RaiseException('Autostart command exceeds the Windows Run limit of 260 UTF-16 code units.');
end;

procedure PreflightAutostart;
var Command, Desired: String; Current: TAutostartOwner;
begin
  Current := CurrentAutostartOwner;
  if not ValidAutostartOwner(Current) then RaiseException('Could not validate current autostart executable path.');
  if ValidAutostartOwner(PendingAutostartOwner) and ValidAutostartOwner(PreviousAutostartOwner) and
     not SameAutostartOwner(PendingAutostartOwner, PreviousAutostartOwner) and
     not SameAutostartOwner(Current, PreviousAutostartOwner) then
    RaiseException('Complete the previous autostart cleanup before changing app ID or installation path.');
  Desired := DesiredAutostartCommand;
  if (Desired <> '') and QueryAutostartCommand(AutostartAppId, Command) and
     not IsKnownAutostartCommand(AutostartAppId, Command) then
    RaiseException('Autostart registration belongs to another installation.');
end;

procedure RemoveAutostartOwner(const Owner: TAutostartOwner);
var Command: String;
begin
  if not ValidAutostartOwner(Owner) then Exit;
  if QueryAutostartCommand(Owner.AppId, Command) and IsAutostartCommandOwner(Command, Owner) then
    if not RegDeleteValue(HKCU64, AutostartRunKey, AutostartName(Owner.AppId)) then
      RaiseException('Could not remove owned autostart registration.');
end;

procedure InstallAutostart;
var Desired, Command: String;
begin
  PreflightAutostart;
  Desired := DesiredAutostartCommand;
  if (Desired <> '') or ValidAutostartOwner(PreviousAutostartOwner) or ValidAutostartOwner(PendingAutostartOwner) then
    if not AutostartDataSaved then RaiseException('Could not persist autostart recovery identity.');
  // Write the new command first. A failed write leaves the predecessor intact;
  // later failures retain the journal so retry/uninstall can remove both owners.
  if Desired <> '' then begin
    if QueryAutostartCommand(AutostartAppId, Command) and
       not IsKnownAutostartCommand(AutostartAppId, Command) then
      RaiseException('Autostart registration belongs to another installation.');
    if Command <> Desired then
      if not RegWriteStringValue(HKCU64, AutostartRunKey, AutostartName(AutostartAppId), Desired) then
        RaiseException('Could not register autostart command.');
  end else RemoveAutostartOwner(CurrentAutostartOwner);
  // Matching paths authorize cleanup; a new command for the same name no longer
  // matches its old owner and is retained. Foreign replacements are also retained.
  if (Desired = '') or not SameAutostartOwner(PreviousAutostartOwner, CurrentAutostartOwner) then
    RemoveAutostartOwner(PreviousAutostartOwner);
  if (Desired = '') or not SameAutostartOwner(PendingAutostartOwner, CurrentAutostartOwner) then
    RemoveAutostartOwner(PendingAutostartOwner);
end;

procedure UninstallAutostart;
begin
  RemoveAutostartOwner(PendingAutostartOwner);
  RemoveAutostartOwner(CurrentAutostartOwner);
end;

procedure RegisterAutostartData(PreviousDataKey: Integer);
var Owner: String;
begin
  if not ValidAutostartOwner(PendingAutostartOwner) then PendingAutostartOwner := PreviousAutostartOwner;
  Owner := '';
  if ValidAutostartOwner(PendingAutostartOwner) then
    Owner := PendingAutostartOwner.AppId + '|' + PendingAutostartOwner.Executable;
  if not SetPreviousData(PreviousDataKey, 'PendingAutostartOwner', Owner) or
     not SetPreviousData(PreviousDataKey, 'AutostartAppId', AutostartAppId) then
    RaiseException('Could not persist autostart recovery identity.');
  InstallationSnapshot.AutostartAppId := AutostartAppId;
  InstallationSnapshot.PendingAutostartOwner := Owner;
  AutostartDataSaved := True;
end;

procedure ClearPendingAutostartOwner;
begin
  if not AutostartDataSaved then Exit;
  WriteAssociationValue(AssociationPreviousDataKey, 'Inno Setup CodeFile: PendingAutostartOwner', '');
  InstallationSnapshot.PendingAutostartOwner := '';
  PendingAutostartOwner.AppId := '';
  PendingAutostartOwner.Executable := '';
end;
`;
}
