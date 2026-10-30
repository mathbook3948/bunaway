import { dlopen, ptr, read, toArrayBuffer } from "bun:ffi";
import { cpus } from "node:os";
import { KERNEL32, pick } from "@bunaway/plugin/win32";
import { BunawayError } from "@bunaway/protocol";
import { MAX_LOGICAL_PROCESSORS, type PowerBlockerType } from "#power/contract";
import { PowerRequestHandles } from "#power/platforms/windows-request-handles";
import {
  cpuSpeedLimit,
  idleSeconds,
  powerStatus,
  readProcessorPower,
  sessionLocked,
  WTS_INFO_EX_MIN_BYTES,
} from "#power/platforms/windows-status";

/** CallNtPowerInformation level that returns one PROCESSOR_POWER_INFORMATION per logical processor. */
const PROCESSOR_INFORMATION_LEVEL = 11;
const POWER_REQUEST_CONTEXT_SIMPLE_STRING = 1;
const REASON_CONTEXT_SIZE = 32;
/** WTS_CURRENT_SESSION, and WTSSessionInfoEx of WTS_INFO_CLASS, for WTSQuerySessionInformationW. */
const WTS_CURRENT_SESSION = 0xffffffff;
const WTS_SESSION_INFO_EX = 25;
const INVALID_HANDLE_VALUE = 0xffffffffffffffffn;
function failure(message: string): never {
  throw new BunawayError({
    code: "INTERNAL",
    message,
  });
}

/** Acquire DLLs at adapter creation and retain all native handles until successfully closed. */
export function createPower() {
  const kernel = dlopen("kernel32.dll", {
    ...pick(KERNEL32, "CloseHandle"),
    GetSystemPowerStatus: {
      args: [
        "ptr",
      ],
      returns: "i32",
    },
    GetTickCount: {
      args: [],
      returns: "u32",
    },
    PowerCreateRequest: {
      args: [
        "ptr",
      ],
      returns: "u64",
    },
    PowerSetRequest: {
      args: [
        "u64",
        "i32",
      ],
      returns: "i32",
    },
    PowerClearRequest: {
      args: [
        "u64",
        "i32",
      ],
      returns: "i32",
    },
  });
  const loadUser = () =>
    dlopen("user32.dll", {
      GetLastInputInfo: {
        args: [
          "ptr",
        ],
        returns: "i32",
      },
    });
  const loadPowrprof = () =>
    dlopen("powrprof.dll", {
      CallNtPowerInformation: {
        args: [
          "i32",
          "ptr",
          "u32",
          "ptr",
          "u32",
        ],
        returns: "i32",
      },
    });
  const loadWts = () =>
    dlopen("wtsapi32.dll", {
      WTSQuerySessionInformationW: {
        args: [
          "u64",
          "u32",
          "i32",
          "ptr",
          "ptr",
        ],
        returns: "i32",
      },
      // A pointer read from the out slot is a plain address, passed as a 64-bit value.
      WTSFreeMemory: {
        args: [
          "u64",
        ],
        returns: "void",
      },
    });
  let user: ReturnType<typeof loadUser>;
  try {
    user = loadUser();
  } catch (error) {
    kernel.close();
    throw error;
  }
  let powrprof: ReturnType<typeof loadPowrprof>;
  try {
    powrprof = loadPowrprof();
  } catch (error) {
    user.close();
    kernel.close();
    throw error;
  }
  let wts: ReturnType<typeof loadWts>;
  try {
    wts = loadWts();
  } catch (error) {
    powrprof.close();
    user.close();
    kernel.close();
    throw error;
  }
  const descriptions = new Set<Buffer>();
  let disposed = false;
  function active() {
    if (disposed) {
      throw new BunawayError({
        code: "CANCELLED",
        message: "Power adapter is disposed.",
      });
    }
  }
  const requests = new PowerRequestHandles({
    create(reason) {
      const description = Buffer.from(`${reason}\0`, "utf16le");
      const context = Buffer.alloc(REASON_CONTEXT_SIZE);
      context.writeUInt32LE(POWER_REQUEST_CONTEXT_SIMPLE_STRING, 4);
      context.writeBigUInt64LE(BigInt(ptr(description)), 8);
      // REASON_CONTEXT stores a raw pointer. Keep its string rooted until Windows copies it.
      descriptions.add(description);
      let handle: bigint;
      try {
        handle = kernel.symbols.PowerCreateRequest(ptr(context));
      } finally {
        descriptions.delete(description);
      }
      if (!handle || handle === INVALID_HANDLE_VALUE) {
        failure("Windows power request creation failed.");
      }
      return handle;
    },
    set: (handle, type) =>
      Boolean(kernel.symbols.PowerSetRequest(handle, type)),
    clear: (handle, type) =>
      Boolean(kernel.symbols.PowerClearRequest(handle, type)),
    close: (handle) => Boolean(kernel.symbols.CloseHandle(handle)),
  });
  return {
    start(type: PowerBlockerType, reason: string) {
      active();
      return requests.start(type, reason);
    },
    stop: (handle: bigint) => requests.stop(handle),
    status() {
      active();
      const data = Buffer.alloc(12);
      if (!kernel.symbols.GetSystemPowerStatus(ptr(data))) {
        failure("Windows power status query failed.");
      }
      return powerStatus(data);
    },
    cpuSpeedLimit() {
      active();
      // The output holds one entry per logical processor, so the buffer follows the processor count.
      const count = cpus().length;
      if (count < 1 || count > MAX_LOGICAL_PROCESSORS) {
        failure("Windows logical processor count is out of range.");
      }
      const { status, data } = readProcessorPower(count, (buffer) =>
        powrprof.symbols.CallNtPowerInformation(
          PROCESSOR_INFORMATION_LEVEL,
          null,
          0,
          ptr(buffer),
          buffer.byteLength,
        ),
      );
      if (status < 0) {
        failure(
          "Windows processor power query failed (NTSTATUS 0x" +
            (status >>> 0).toString(16) +
            ").",
        );
      }
      try {
        return cpuSpeedLimit(data);
      } catch {
        return failure(
          "Windows processor power query returned malformed data.",
        );
      }
    },
    idle() {
      active();
      const info = Buffer.alloc(8);
      info.writeUInt32LE(8);
      if (!user.symbols.GetLastInputInfo(ptr(info))) {
        failure("Windows last input query failed.");
      }
      return idleSeconds(kernel.symbols.GetTickCount(), info.readUInt32LE(4));
    },
    sessionLocked() {
      active();
      // Out slots: the system-allocated buffer pointer at 0 and its byte count at 8.
      const out = Buffer.alloc(16);
      const outAddress = ptr(out);
      if (
        !wts.symbols.WTSQuerySessionInformationW(
          0n,
          WTS_CURRENT_SESSION,
          WTS_SESSION_INFO_EX,
          outAddress,
          ptr(out, 8),
        )
      ) {
        failure("Windows session information query failed.");
      }
      const address = read.ptr(outAddress, 0);
      const bytes = read.u32(outAddress, 8);
      if (!address) {
        failure("Windows session information query returned no data.");
      }
      // The buffer belongs to the system, so it is released on every path after a successful query.
      try {
        if (bytes < WTS_INFO_EX_MIN_BYTES) {
          failure("Windows session information is too short.");
        }
        return sessionLocked(new Uint8Array(toArrayBuffer(address, 0, bytes)));
      } catch (error) {
        if (error instanceof BunawayError) {
          throw error;
        }
        return failure("Windows session lock state is unknown.");
      } finally {
        wts.symbols.WTSFreeMemory(BigInt(address));
      }
    },
    dispose() {
      if (disposed) {
        return;
      }
      requests.dispose();
      disposed = true;
      wts.close();
      powrprof.close();
      user.close();
      kernel.close();
    },
  };
}
