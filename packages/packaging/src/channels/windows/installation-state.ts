import { stableGuid } from "./common.ts";

/** Keeps setup and maintenance names stable across installer versions and channels. */
export function installationMutexNames(identifier: string) {
  const id = stableGuid(identifier);
  return {
    setup: `Global\\Bunaway.Setup.${id}`,
    maintenance: `Global\\Bunaway.Maintenance.${id}`,
  };
}

/**
 * Emits process-owned setup/uninstall coordination and one previous-data snapshot.
 * Emit procedures after association code to reuse its checked registry reader.
 */
export function renderInstallationStateCode(identifier: string) {
  const names = installationMutexNames(identifier);
  return {
    setupMutex: names.setup,
    declarations: `
type TInstallationSnapshot = record
  ExecutableName: String;
  InstallDir: String;
  PendingOwner: String;
  AutostartAppId: String;
  PendingAutostartOwner: String;
end;
var MaintenanceMutexHandle: THandle;
    InstallationSnapshot: TInstallationSnapshot;
    InstallationSnapshotLoaded: Boolean;
`,
    procedures: `
const MaintenanceMutexName = '${names.maintenance}';
      MUTEX_WAIT_ACQUIRED = 0;
      MUTEX_WAIT_ABANDONED = 128;
      MUTEX_WAIT_TIMEOUT = 258;

// Inno 6.7's script process is 32-bit even in 64-bit installation mode. Use its
// supported LongWord/LongBool types for the null pointer, DWORD and Win32 BOOL.
function CreateMaintenanceMutex(SecurityAttributes: LongWord; InitialOwner: LongBool; Name: String): THandle;
  external 'CreateMutexW@kernel32.dll stdcall';
function WaitMaintenanceMutex(Handle: THandle; Milliseconds: LongWord): LongWord;
  external 'WaitForSingleObject@kernel32.dll stdcall';
function CloseMaintenanceMutex(Handle: THandle): LongBool;
  external 'CloseHandle@kernel32.dll stdcall';

function AcquireInstallationMaintenance: Boolean;
var Status: LongWord;
begin
  Result := False;
  MaintenanceMutexHandle := CreateMaintenanceMutex(0, False, MaintenanceMutexName);
  if MaintenanceMutexHandle = 0 then begin
    Log('Could not create installation maintenance mutex.');
    Exit;
  end;
  // Waiting, rather than check-then-create, atomically owns the mutex. An
  // abandoned owner is recoverable; its previous-data snapshot still needs validation.
  Status := WaitMaintenanceMutex(MaintenanceMutexHandle, 0);
  Result := (Status = MUTEX_WAIT_ACQUIRED) or (Status = MUTEX_WAIT_ABANDONED);
  // Successful ownership lasts until Windows terminates this process. Script
  // Deinitialize events precede native final bookkeeping and uninstaller self-deletion.
  // Releasing there would let another setup overwrite files still being cleaned up.
  if not Result then begin
    CloseMaintenanceMutex(MaintenanceMutexHandle);
    MaintenanceMutexHandle := 0;
    if Status = MUTEX_WAIT_TIMEOUT then
      Log('Another setup or uninstall is maintaining this application.')
    else
      Log('Could not acquire installation maintenance mutex: ' + IntToStr(Status));
  end;
end;

function ReadInstallationIdentityValue(const Name: String): String;
begin
  Result := '';
  try
    // Use the same status-aware reader as association ownership. Inno's
    // GetPreviousData silently returns its default on access or type failures.
    // The shipped key, hive, view and CodeFile prefix match Inno's lookup.
    QueryAssociationValue(AssociationPreviousDataKey, 'Inno Setup CodeFile: ' + Name, Result);
  except
    RaiseException('Could not read installation identity: ' + Name + '. ' + GetExceptionMessage);
  end;
end;

function ReadInstallationSnapshot: TInstallationSnapshot;
begin
  Result.ExecutableName := ReadInstallationIdentityValue('ExecutableName');
  Result.InstallDir := ReadInstallationIdentityValue('InstallDir');
  Result.PendingOwner := ReadInstallationIdentityValue('PendingAssociationOwner');
  Result.AutostartAppId := ReadInstallationIdentityValue('AutostartAppId');
  Result.PendingAutostartOwner := ReadInstallationIdentityValue('PendingAutostartOwner');
end;

procedure CaptureInstallationSnapshot;
begin
  // Cooperating setup/uninstall processes hold the maintenance mutex for their
  // entire lifetime, so the identity fields form one consistent identity snapshot.
  InstallationSnapshot := ReadInstallationSnapshot;
  InstallationSnapshotLoaded := True;
end;

procedure ValidateInstallationSnapshot;
var Current: TInstallationSnapshot;
begin
  if not InstallationSnapshotLoaded then
    RaiseException('Installation identity snapshot is unavailable.');
  Current := ReadInstallationSnapshot;
  // Detect legacy installers and external changes during a delayed wizard too.
  // Do not refresh only one field and combine it with a cached pending identity.
  if (Current.ExecutableName <> InstallationSnapshot.ExecutableName) or
     (Current.InstallDir <> InstallationSnapshot.InstallDir) or
     (Current.PendingOwner <> InstallationSnapshot.PendingOwner) or
     (Current.AutostartAppId <> InstallationSnapshot.AutostartAppId) or
     (Current.PendingAutostartOwner <> InstallationSnapshot.PendingAutostartOwner) then
    RaiseException('Installation state changed while this setup or uninstall was open. Close it and start again.');
end;
`,
  };
}
