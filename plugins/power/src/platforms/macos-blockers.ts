import { dlopen, ptr } from "bun:ffi";
import { failWithCleanup, ResourceOwner } from "@bunaway/plugin";
import { COREFOUNDATION, COREFOUNDATION_PATH } from "@bunaway/plugin/darwin";
import { pick } from "@bunaway/plugin/win32";
import { BunawayError } from "@bunaway/protocol";
import type { PowerRequestNative } from "#power/blockers";
import type { PowerBlockerType } from "#power/contract";

const IOKIT = "/System/Library/Frameworks/IOKit.framework/IOKit";

const UTF8_ENCODING = 0x08000100;
/** `kIOReturnSuccess`. */
const IO_RETURN_SUCCESS = 0;
/** `kIOPMAssertionLevelOn`: the assertion is in effect. */
const ASSERTION_LEVEL_ON = 255;
/**
 * IOPMAssertion type names from IOPMLib.h. The system type keeps the machine awake while the user
 * is idle and the display type also keeps the display on; they match Electron's
 * `prevent-app-suspension` and `prevent-display-sleep`.
 */
const ASSERTION_TYPES = {
  system: "PreventUserIdleSystemSleep",
  display: "PreventUserIdleDisplaySleep",
} as const satisfies Record<PowerBlockerType, string>;

function failure(message: string): never {
  throw new BunawayError({
    code: "INTERNAL",
    message,
  });
}

function openCoreFoundation(owner: ResourceOwner) {
  return owner.acquire(
    () =>
      dlopen(
        COREFOUNDATION_PATH,
        pick(COREFOUNDATION, "CFRelease", "CFStringCreateWithCString"),
      ),
    (library) => library.close(),
  );
}

function openIokit(owner: ResourceOwner) {
  return owner.acquire(
    () =>
      dlopen(IOKIT, {
        IOPMAssertionCreateWithName: {
          args: [
            "ptr",
            "u32",
            "ptr",
            "ptr",
          ],
          returns: "i32",
        },
        IOPMAssertionRelease: {
          args: [
            "u32",
          ],
          returns: "i32",
        },
      } as const),
    (library) => library.close(),
  );
}

type CoreFoundation = ReturnType<typeof openCoreFoundation>;
type Iokit = ReturnType<typeof openIokit>;

/**
 * Create one assertion. The CFStrings it needs are released before returning on every path,
 * because IOPMAssertionCreateWithName copies them.
 */
function createAssertion(
  core: CoreFoundation,
  iokit: Iokit,
  type: string,
  reason: string,
): bigint {
  const strings: NonNullable<
    ReturnType<CoreFoundation["symbols"]["CFStringCreateWithCString"]>
  >[] = [];
  const cfString = (text: string) => {
    const created = core.symbols.CFStringCreateWithCString(
      null,
      text,
      UTF8_ENCODING,
    );
    if (!created) {
      return failure("macOS could not create a power assertion string.");
    }
    strings.push(created);
    return created;
  };
  try {
    const id = new Uint32Array(1);
    const status = iokit.symbols.IOPMAssertionCreateWithName(
      cfString(type),
      ASSERTION_LEVEL_ON,
      cfString(reason),
      ptr(id),
    );
    if (status !== IO_RETURN_SUCCESS) {
      return failure(`macOS could not create a power assertion (${status}).`);
    }
    return BigInt(id[0] ?? 0);
  } finally {
    for (const string of strings) {
      core.symbols.CFRelease(string);
    }
  }
}

/** Assertion requests handed to `PowerBlockers`; `dispose` closes only the libraries. */
export type MacosAssertions = PowerRequestNative & {
  dispose(): void;
};

/**
 * Bindings for IOPMAssertionCreateWithName and IOPMAssertionRelease. A started assertion belongs
 * to the caller until `stop` releases it. `dispose` closes the libraries and refuses while an
 * assertion is still open, because a later release would call into an unloaded framework and the
 * caller can retry once the assertion is gone. The calls need no particular thread.
 */
export function createMacosAssertions(): MacosAssertions {
  const owner = new ResourceOwner("macOS power assertion cleanup failed.");
  const open = new Set<bigint>();
  let core: CoreFoundation;
  let iokit: Iokit;
  try {
    core = openCoreFoundation(owner);
    iokit = openIokit(owner);
  } catch (error) {
    // No caller receives the bindings, so release the libraries opened before the failure here.
    failWithCleanup(
      error,
      () => owner.dispose(),
      "macOS power assertion cleanup failed.",
    );
  }
  return {
    start(type, reason) {
      const handle = createAssertion(
        core,
        iokit,
        ASSERTION_TYPES[type],
        reason,
      );
      open.add(handle);
      return handle;
    },
    stop(handle) {
      const status = iokit.symbols.IOPMAssertionRelease(Number(handle));
      if (status !== IO_RETURN_SUCCESS) {
        failure(`macOS could not release the power assertion (${status}).`);
      }
      open.delete(handle);
    },
    dispose() {
      if (open.size > 0) {
        failure("macOS power assertions are still open.");
      }
      owner.dispose();
    },
  };
}
