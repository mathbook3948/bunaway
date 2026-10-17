import { dlopen } from "bun:ffi";
import { KERNEL32, pick } from "@bunaway/plugin/win32";

/** Win64 process, Job and pipe bindings. Each invocation owns the returned library. */
export function openProcessBindings() {
  return dlopen("kernel32.dll", {
    ...pick(
      KERNEL32,
      "GetLastError",
      "CloseHandle",
      "CreateJobObjectW",
      "SetInformationJobObject",
      "QueryInformationJobObject",
      "CreateProcessW",
      "WaitForSingleObject",
      "ReadFile",
      "WriteFile",
      "CreateFileW",
    ),
    TerminateJobObject: {
      args: [
        "u64",
        "u32",
      ],
      returns: "i32",
    },
    InitializeProcThreadAttributeList: {
      args: [
        "ptr",
        "u32",
        "u32",
        "ptr",
      ],
      returns: "i32",
    },
    UpdateProcThreadAttribute: {
      args: [
        "ptr",
        "u32",
        "u64",
        "ptr",
        "u64",
        "ptr",
        "ptr",
      ],
      returns: "i32",
    },
    DeleteProcThreadAttributeList: {
      args: [
        "ptr",
      ],
      returns: "void",
    },
    GetExitCodeProcess: {
      args: [
        "u64",
        "ptr",
      ],
      returns: "i32",
    },
    CreatePipe: {
      args: [
        "ptr",
        "ptr",
        "ptr",
        "u32",
      ],
      returns: "i32",
    },
    SetHandleInformation: {
      args: [
        "u64",
        "u32",
        "u32",
      ],
      returns: "i32",
    },
    PeekNamedPipe: {
      args: [
        "u64",
        "ptr",
        "u32",
        "ptr",
        "ptr",
        "ptr",
      ],
      returns: "i32",
    },
    CreateNamedPipeW: {
      args: [
        "ptr",
        "u32",
        "u32",
        "u32",
        "u32",
        "u32",
        "u32",
        "ptr",
      ],
      returns: "u64",
    },
    ConnectNamedPipe: {
      args: [
        "u64",
        "ptr",
      ],
      returns: "i32",
    },
    GetOverlappedResult: {
      args: [
        "u64",
        "ptr",
        "ptr",
        "i32",
      ],
      returns: "i32",
    },
    CancelIoEx: {
      args: [
        "u64",
        "ptr",
      ],
      returns: "i32",
    },
  });
}
export type ProcessBindings = ReturnType<typeof openProcessBindings>;
