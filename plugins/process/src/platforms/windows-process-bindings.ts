import { dlopen } from "bun:ffi";

/** Win64 process, Job and pipe bindings. Each invocation owns the returned library. */
export function openProcessBindings() {
  return dlopen("kernel32.dll", {
    GetLastError: {
      args: [],
      returns: "u32",
    },
    CloseHandle: {
      args: [
        "u64",
      ],
      returns: "i32",
    },
    CreateJobObjectW: {
      args: [
        "ptr",
        "ptr",
      ],
      returns: "u64",
    },
    SetInformationJobObject: {
      args: [
        "u64",
        "i32",
        "ptr",
        "u32",
      ],
      returns: "i32",
    },
    QueryInformationJobObject: {
      args: [
        "u64",
        "i32",
        "ptr",
        "u32",
        "ptr",
      ],
      returns: "i32",
    },
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
    CreateProcessW: {
      args: [
        "ptr",
        "ptr",
        "ptr",
        "ptr",
        "i32",
        "u32",
        "ptr",
        "ptr",
        "ptr",
        "ptr",
      ],
      returns: "i32",
    },
    WaitForSingleObject: {
      args: [
        "u64",
        "u32",
      ],
      returns: "u32",
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
    ReadFile: {
      args: [
        "u64",
        "ptr",
        "u32",
        "ptr",
        "ptr",
      ],
      returns: "i32",
    },
    WriteFile: {
      args: [
        "u64",
        "ptr",
        "u32",
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
