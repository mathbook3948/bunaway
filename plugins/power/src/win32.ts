import { dlopen, ptr } from "bun:ffi";
import { BunawayError } from "@bunaway/protocol";
import type { PowerBlockerType } from "./contract.ts";
import { PowerRequestHandles } from "./request-handles.ts";
import { idleSeconds, powerStatus } from "./status.ts";

const POWER_REQUEST_CONTEXT_SIMPLE_STRING = 1;
const REASON_CONTEXT_SIZE = 32;
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
    CloseHandle: {
      args: [
        "u64",
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
  let user: ReturnType<typeof loadUser>;
  try {
    user = loadUser();
  } catch (error) {
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
    idle() {
      active();
      const info = Buffer.alloc(8);
      info.writeUInt32LE(8);
      if (!user.symbols.GetLastInputInfo(ptr(info))) {
        failure("Windows last input query failed.");
      }
      return idleSeconds(kernel.symbols.GetTickCount(), info.readUInt32LE(4));
    },
    dispose() {
      if (disposed) {
        return;
      }
      requests.dispose();
      disposed = true;
      user.close();
      kernel.close();
    },
  };
}
