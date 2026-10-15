import {
  AUTOSTART_MUTEX_PREFIX,
  AUTOSTART_MUTEX_WAIT_MS,
} from "@bunaway/protocol";

/** Emit cross-session exclusion shared with the runtime's user-scoped Run writers. */
export function renderAutostartLockCode(): string {
  return `
const AutostartMutexPrefix = '${AUTOSTART_MUTEX_PREFIX}';
      AUTOSTART_MUTEX_WAIT_MS = ${AUTOSTART_MUTEX_WAIT_MS};
      AUTOSTART_TOKEN_QUERY = 8;
      AUTOSTART_TOKEN_USER = 1;
      AUTOSTART_TOKEN_USER_BYTES = 76;
      AUTOSTART_MUTEX_ACCESS = 1048577;

type TAutostartSidBytes = array[0..67] of Byte;
     TAutostartTokenUser = record
       Sid: LongWord;
       Attributes: LongWord;
       Storage: TAutostartSidBytes;
     end;
     TAutostartMutexHandles = array of THandle;

// Inno 6.7's 32-bit script uses an 8-byte SID_AND_ATTRIBUTES header and a SID
// of at most 68 bytes. The runtime uses its native 64-bit TOKEN_USER layout.
function AutostartCurrentProcess: THandle;
  external 'GetCurrentProcess@kernel32.dll stdcall';
function OpenAutostartProcessToken(Process: THandle; Access: LongWord; var Token: THandle): LongBool;
  external 'OpenProcessToken@advapi32.dll stdcall';
function GetAutostartTokenInformation(Token: THandle; Kind: LongWord; var Info: TAutostartTokenUser; Bytes: LongWord; var RequiredBytes: LongWord): LongBool;
  external 'GetTokenInformation@advapi32.dll stdcall';
function FormatAutostartSid(Sid: LongWord; var Text: LongWord): LongBool;
  external 'ConvertSidToStringSidW@advapi32.dll stdcall';
function CopyAutostartSidText(Buffer: String; Text: LongWord; Characters: Integer): LongWord;
  external 'lstrcpynW@kernel32.dll stdcall';
function FreeAutostartSidText(Text: LongWord): LongWord;
  external 'LocalFree@kernel32.dll stdcall';
function CreateAutostartMutex(SecurityAttributes: LongWord; Name: String; Flags, Access: LongWord): THandle;
  external 'CreateMutexExW@kernel32.dll stdcall';
function ReleaseAutostartMutex(Handle: THandle): LongBool;
  external 'ReleaseMutex@kernel32.dll stdcall';

function AutostartUserSid: String;
var Token: THandle; Info: TAutostartTokenUser; RequiredBytes, Text: LongWord;
begin
  if not OpenAutostartProcessToken(AutostartCurrentProcess, AUTOSTART_TOKEN_QUERY, Token) then
    RaiseException('Could not inspect autostart user token.');
  try
    if not GetAutostartTokenInformation(Token, AUTOSTART_TOKEN_USER, Info, AUTOSTART_TOKEN_USER_BYTES, RequiredBytes) then
      RaiseException('Could not read autostart user SID.');
    if not FormatAutostartSid(Info.Sid, Text) then
      RaiseException('Could not format autostart user SID.');
    try
      Result := StringOfChar(#0, 256);
      if CopyAutostartSidText(Result, Text, Length(Result)) = 0 then
        RaiseException('Could not copy autostart user SID.');
      StringChangeEx(Result, #0, '', True);
      if Result = '' then RaiseException('Autostart user SID is unavailable.');
    finally
      if FreeAutostartSidText(Text) <> 0 then RaiseException('Could not release autostart SID text.');
    end;
  finally
    if not CloseMaintenanceMutex(Token) then RaiseException('Could not close autostart user token.');
  end;
end;

procedure ReleaseAutostartLocks(var Handles: TAutostartMutexHandles);
var I: Integer; ErrorMessage: String;
begin
  ErrorMessage := '';
  // Release every owned handle even when an earlier release fails.
  for I := GetArrayLength(Handles) - 1 downto 0 do begin
    if not ReleaseAutostartMutex(Handles[I]) then
      ErrorMessage := ErrorMessage + 'Could not release autostart mutex. ';
    if not CloseMaintenanceMutex(Handles[I]) then
      ErrorMessage := ErrorMessage + 'Could not close autostart mutex. ';
  end;
  SetArrayLength(Handles, 0);
  if ErrorMessage <> '' then RaiseException(ErrorMessage);
end;

procedure AcquireAutostartLocks(const CurrentId, PreviousId, PendingId: String; var Handles: TAutostartMutexHandles);
var Names: TStringList; I, Count: Integer; Sid, ErrorMessage: String;
    Handle: THandle; Status: LongWord;
begin
  SetArrayLength(Handles, 0);
  Names := TStringList.Create;
  try
    Names.Sorted := True;
    Names.Add(CurrentId);
    if (PreviousId <> '') and (Names.IndexOf(PreviousId) < 0) then Names.Add(PreviousId);
    if (PendingId <> '') and (Names.IndexOf(PendingId) < 0) then Names.Add(PendingId);
    Sid := AutostartUserSid;
    try
      // Sort complete Run identities so concurrent ID migrations cannot deadlock.
      // Keep every relevant identity locked through reads, writes and retirement.
      for I := 0 to Names.Count - 1 do begin
        Handle := CreateAutostartMutex(0, AutostartMutexPrefix + Sid + '.bunaway.packaged.' + Names[I], 0, AUTOSTART_MUTEX_ACCESS);
        if Handle = 0 then RaiseException('Could not create autostart mutex.');
        Status := WaitMaintenanceMutex(Handle, AUTOSTART_MUTEX_WAIT_MS);
        if (Status <> MUTEX_WAIT_ACQUIRED) and (Status <> MUTEX_WAIT_ABANDONED) then begin
          CloseMaintenanceMutex(Handle);
          if Status = MUTEX_WAIT_TIMEOUT then
            RaiseException('Another process is maintaining this autostart registration.');
          RaiseException('Could not acquire autostart mutex.');
        end;
        Count := GetArrayLength(Handles);
        SetArrayLength(Handles, Count + 1);
        Handles[Count] := Handle;
      end;
    except
      ErrorMessage := GetExceptionMessage;
      try ReleaseAutostartLocks(Handles);
      except ErrorMessage := ErrorMessage + ' ' + GetExceptionMessage; end;
      RaiseException(ErrorMessage);
    end;
  finally
    Names.Free;
  end;
end;
`;
}
