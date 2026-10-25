import { CFunction, dlopen, type Pointer, ptr, read } from "bun:ffi";
import { attemptAll } from "@bunaway/plugin";
import { COMBASE, pick } from "@bunaway/plugin/win32";
import { BunawayError, MSIX_STARTUP_TASK_ID } from "@bunaway/protocol";
import type { z } from "zod";
import type { AutostartStatus, enableSchema } from "#autostart/contract";
import { invalid } from "#autostart/platforms/launch";

/**
 * Autostart for a process with MSIX package identity. The Run key is not available there, so the
 * plugin drives the manifest `desktop:StartupTask` (`Windows.ApplicationModel.StartupTask`) through
 * a small WinRT binding. Interface IDs and vtable slots follow the Windows SDK metadata.
 */

const STARTUP_TASK_CLASS = "Windows.ApplicationModel.StartupTask";
const STATICS_IID = "ee5b60bd-a148-41a7-b26e-e8b88a1e62f8";
const ASYNC_INFO_IID = "00000036-0000-0000-c000-000000000046";
/** IUnknown occupies slots 0 to 2 (QueryInterface, AddRef, Release); IInspectable adds 3 to 5. */
const SLOT_QUERY_INTERFACE = 0;
const SLOT_RELEASE = 2;
/** IStartupTaskStatics: GetAsync(HSTRING taskId, IAsyncOperation<StartupTask>**). */
const SLOT_GET_ASYNC = 7;
/** IStartupTask: RequestEnableAsync, Disable, get_State. */
const SLOT_REQUEST_ENABLE = 6;
const SLOT_DISABLE = 7;
const SLOT_GET_STATE = 8;
/** IAsyncOperation<T>: put_Completed 6, get_Completed 7, GetResults 8. */
const SLOT_GET_RESULTS = 8;
/** IAsyncInfo: Id 6, Status 7, ErrorCode 8, Cancel 9. */
const SLOT_ASYNC_STATUS = 7;
const SLOT_ASYNC_ERROR_CODE = 8;
const SLOT_ASYNC_CANCEL = 9;
const POINTER_BYTES = 8;
const RO_INIT_SINGLETHREADED = 0;
const S_FALSE = 1;
const RPC_E_CHANGED_MODE = 0x80010106;
const E_ACCESSDENIED = 0x80070005;
const APPMODEL_ERROR_NO_PACKAGE_HRESULT = 0x80073d54;
/** Windows.Foundation.AsyncStatus. */
const ASYNC_STARTED = 0;
const ASYNC_CANCELED = 2;
const ASYNC_ERROR = 3;
/** The state poll keeps the I/O worker responsive and bounds a task that never completes. */
const POLL_INTERVAL_MS = 10;
export const STARTUP_TASK_TIMEOUT_MS = 10_000;

/** Windows.ApplicationModel.StartupTaskState. */
export const STARTUP_TASK_STATE = {
  disabled: 0,
  disabledByUser: 1,
  enabled: 2,
  disabledByPolicy: 3,
  enabledByPolicy: 4,
} as const;

const KNOWN_STATES = new Set<number>(Object.values(STARTUP_TASK_STATE));

/** One opened task. Each call runs against the task the manifest declares. */
export interface StartupTaskApi {
  state(): number;
  /** Ask Windows to enable the task and resolve with the resulting `StartupTaskState`. */
  requestEnable(signal: AbortSignal | undefined): Promise<number>;
  disable(): void;
}
/** Opens the manifest task for one operation and releases every WinRT object afterwards. */
export type StartupTaskOpener = <T>(
  signal: AbortSignal | undefined,
  use: (task: StartupTaskApi) => Promise<T>,
) => Promise<T>;

type EnableInput = z.output<typeof enableSchema>;

/**
 * Express a task state through the existing status fields. A task the user or policy turned off
 * cannot be enabled by the app, so those states read as `disabled`; only a user-disabled task
 * counts as registered, because the app enabled it or the user chose to turn it off.
 */
export function startupTaskStatus(state: number): AutostartStatus {
  const enabled =
    state === STARTUP_TASK_STATE.enabled ||
    state === STARTUP_TASK_STATE.enabledByPolicy;
  return {
    registrationName: MSIX_STARTUP_TASK_ID,
    registered: enabled || state === STARTUP_TASK_STATE.disabledByUser,
    commandLine: null,
    executablePath: null,
    args: null,
    startupState: startupStateOf(state, enabled),
    matchesCurrentLaunch: false,
  };
}

/** A value outside the documented enumeration stays `unknown` instead of reading as disabled. */
function startupStateOf(
  state: number,
  enabled: boolean,
): AutostartStatus["startupState"] {
  if (enabled) {
    return "enabled";
  }
  return KNOWN_STATES.has(state) ? "disabled" : "unknown";
}

export function getPackagedStatus(
  open: StartupTaskOpener,
  signal: AbortSignal | undefined,
): Promise<AutostartStatus> {
  return open(signal, (task) =>
    Promise.resolve(startupTaskStatus(task.state())),
  );
}

/**
 * Request enablement once. A task the user or policy disabled stays disabled and the result says
 * so, which keeps the user's choice, as the Run registration does.
 */
export function enablePackaged(
  open: StartupTaskOpener,
  input: EnableInput,
  signal: AbortSignal | undefined,
): Promise<AutostartStatus> {
  // The manifest launches the executable without arguments, so neither can be carried.
  if (input.args.length > 0 || input.hidden) {
    invalid("MSIX startup tasks cannot pass arguments or hidden startup.");
  }
  return open(signal, async (task) => {
    const state = task.state();
    if (state !== STARTUP_TASK_STATE.disabled) {
      return startupTaskStatus(state);
    }
    return startupTaskStatus(await task.requestEnable(signal));
  });
}

export function disablePackaged(
  open: StartupTaskOpener,
  signal: AbortSignal | undefined,
): Promise<null> {
  return open(signal, (task) => {
    task.disable();
    return Promise.resolve(null);
  });
}

function windowsGuid(value: string): Buffer {
  const bytes = Buffer.from(value.replaceAll("-", ""), "hex");
  bytes.subarray(0, 4).reverse();
  bytes.subarray(4, 6).reverse();
  bytes.subarray(6, 8).reverse();
  return bytes;
}

function failure(result: number, stage: string): BunawayError {
  const hresult = result >>> 0;
  let code: "UNSUPPORTED" | "PERMISSION_DENIED" | "INTERNAL" = "INTERNAL";
  if (hresult === APPMODEL_ERROR_NO_PACKAGE_HRESULT) {
    code = "UNSUPPORTED";
  } else if (hresult === E_ACCESSDENIED) {
    code = "PERMISSION_DENIED";
  }
  return new BunawayError({
    code,
    message: "Windows startup task operation failed.",
    details: {
      stage,
      hresult,
    },
  });
}

function check(result: number, stage: string): void {
  if (result < 0) {
    throw failure(result, stage);
  }
}

/** Call a COM method by vtable slot. `args` describes the arguments after `this`. */
function method(
  object: Pointer,
  slot: number,
  args: ("ptr" | "i32")[],
  ...values: (Pointer | number | null)[]
): number {
  const address = read.ptr(read.ptr(object), slot * POINTER_BYTES);
  if (!address) {
    throw new BunawayError({
      code: "INTERNAL",
      message: "Missing startup task COM method.",
    });
  }
  const call = CFunction({
    ptr: address as Pointer,
    args: [
      "ptr",
      ...args,
    ],
    returns: "i32",
  });
  try {
    return Number(call(object, ...values));
  } finally {
    call.close();
  }
}

/** Stop before work that could show a consent prompt or touch the task once the caller gave up. */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new BunawayError({
      code: "CANCELLED",
      message: "Windows startup task operation was cancelled.",
    });
  }
}

/** Wait for an async operation, cancelling it when the caller aborts or the time limit passes. */
async function completed(
  operation: Pointer,
  signal: AbortSignal | undefined,
  own: (object: Pointer) => Pointer,
  stage: string,
): Promise<void> {
  const out = new BigUint64Array(1);
  const iid = windowsGuid(ASYNC_INFO_IID);
  check(
    method(
      operation,
      SLOT_QUERY_INTERFACE,
      [
        "ptr",
        "ptr",
      ],
      ptr(iid),
      ptr(out),
    ),
    stage,
  );
  const info = own(Number(out[0]) as Pointer);
  const status = new Int32Array(1);
  const deadline = performance.now() + STARTUP_TASK_TIMEOUT_MS;
  for (;;) {
    check(
      method(
        info,
        SLOT_ASYNC_STATUS,
        [
          "ptr",
        ],
        ptr(status),
      ),
      stage,
    );
    if (status[0] !== ASYNC_STARTED) {
      break;
    }
    const aborted = signal?.aborted === true;
    if (aborted || performance.now() >= deadline) {
      method(info, SLOT_ASYNC_CANCEL, []);
      throw new BunawayError({
        code: aborted ? "CANCELLED" : "TIMEOUT",
        message: "Windows startup task operation did not complete.",
      });
    }
    await Bun.sleep(POLL_INTERVAL_MS);
  }
  if (status[0] === ASYNC_CANCELED) {
    throw new BunawayError({
      code: "CANCELLED",
      message: "Windows startup task operation was cancelled.",
    });
  }
  if (status[0] === ASYNC_ERROR) {
    const error = new Int32Array(1);
    check(
      method(
        info,
        SLOT_ASYNC_ERROR_CODE,
        [
          "ptr",
        ],
        ptr(error),
      ),
      stage,
    );
    throw failure(error[0] ?? -1, stage);
  }
}

/**
 * Open the manifest task for one operation. WinRT objects, the HSTRING and the combase library
 * live only for the call. The apartment mode matches the notification runtime that shares the I/O
 * worker, so neither plugin can make the other's `RoInitialize` fail while this call waits. The
 * wait polls status and never needs a message pump, and a thread that already joined another
 * apartment keeps it, because the agile StartupTask objects work in either.
 */
export const openStartupTask: StartupTaskOpener = async (signal, use) => {
  throwIfAborted(signal);
  const library = dlopen(
    "combase.dll",
    pick(
      COMBASE,
      "RoInitialize",
      "RoUninitialize",
      "RoGetActivationFactory",
      "WindowsCreateString",
      "WindowsDeleteString",
    ),
  );
  const held: Pointer[] = [];
  // Objects are released in reverse order of acquisition, whether the operation succeeded or not.
  const own = (object: Pointer): Pointer => {
    held.push(object);
    return object;
  };
  const outObject = (invoke: (out: Pointer) => number, stage: string) => {
    const out = new BigUint64Array(1);
    check(invoke(ptr(out)), stage);
    if (!out[0]) {
      throw new BunawayError({
        code: "UNSUPPORTED",
        message: "The package manifest declares no autostart startup task.",
      });
    }
    return own(Number(out[0]) as Pointer);
  };
  const withString = <T>(value: string, run: (text: Pointer) => T): T => {
    const text = Buffer.from(value, "utf16le");
    const out = new BigUint64Array(1);
    check(
      library.symbols.WindowsCreateString(ptr(text), value.length, ptr(out)),
      "WindowsCreateString",
    );
    const handle = Number(out[0]) as Pointer;
    try {
      return run(handle);
    } finally {
      library.symbols.WindowsDeleteString(handle);
    }
  };
  try {
    const initialized = library.symbols.RoInitialize(RO_INIT_SINGLETHREADED);
    const joined = initialized >= 0 && initialized <= S_FALSE;
    if (!joined && initialized >>> 0 !== RPC_E_CHANGED_MODE) {
      throw failure(initialized, "RoInitialize");
    }
    let outcome:
      | {
          value: Awaited<ReturnType<typeof use>>;
        }
      | {
          error: unknown;
        };
    try {
      const staticsIid = windowsGuid(STATICS_IID);
      const statics = withString(STARTUP_TASK_CLASS, (name) =>
        outObject(
          (out) =>
            library.symbols.RoGetActivationFactory(name, ptr(staticsIid), out),
          "RoGetActivationFactory",
        ),
      );
      const opening = withString(MSIX_STARTUP_TASK_ID, (taskId) =>
        outObject(
          (out) =>
            method(
              statics,
              SLOT_GET_ASYNC,
              [
                "ptr",
                "ptr",
              ],
              taskId,
              out,
            ),
          "GetAsync",
        ),
      );
      await completed(opening, signal, own, "GetAsync");
      // GetResults yields null for an ID the manifest does not declare; outObject reports it.
      const task = outObject(
        (out) =>
          method(
            opening,
            SLOT_GET_RESULTS,
            [
              "ptr",
            ],
            out,
          ),
        "GetAsync.GetResults",
      );
      throwIfAborted(signal);
      outcome = {
        value: await use({
          state() {
            const state = new Int32Array(1);
            check(
              method(
                task,
                SLOT_GET_STATE,
                [
                  "ptr",
                ],
                ptr(state),
              ),
              "get_State",
            );
            return state[0] ?? -1;
          },
          async requestEnable(abort) {
            throwIfAborted(abort);
            const request = outObject(
              (out) =>
                method(
                  task,
                  SLOT_REQUEST_ENABLE,
                  [
                    "ptr",
                  ],
                  out,
                ),
              "RequestEnableAsync",
            );
            await completed(request, abort, own, "RequestEnableAsync");
            const state = new Int32Array(1);
            check(
              method(
                request,
                SLOT_GET_RESULTS,
                [
                  "ptr",
                ],
                ptr(state),
              ),
              "RequestEnableAsync.GetResults",
            );
            return state[0] ?? -1;
          },
          disable() {
            check(method(task, SLOT_DISABLE, []), "Disable");
          },
        }),
      };
    } catch (error) {
      outcome = {
        error,
      };
    }
    // Release every object and leave the apartment even when one release fails. A failed release
    // never replaces the operation's own failure.
    try {
      attemptAll(
        [
          ...held.reverse().map((object) => () => {
            method(object, SLOT_RELEASE, []);
          }),
          () => {
            if (joined) {
              library.symbols.RoUninitialize();
            }
          },
        ],
        "Could not release the startup task objects.",
      );
    } catch (cleanupError) {
      if ("value" in outcome) {
        throw cleanupError;
      }
    }
    if ("error" in outcome) {
      throw outcome.error;
    }
    return outcome.value;
  } finally {
    library.close();
  }
};
