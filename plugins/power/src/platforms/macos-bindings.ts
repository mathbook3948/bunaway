import { dlopen, type Pointer, ptr } from "bun:ffi";
import { ResourceOwner } from "@bunaway/plugin";
import {
  COREFOUNDATION,
  COREFOUNDATION_PATH,
  OBJC_PATH,
  OBJC_RUNTIME,
} from "@bunaway/plugin/darwin";
import { pick } from "@bunaway/plugin/win32";
import { BunawayError } from "@bunaway/protocol";
import { MAX_IDLE_SECONDS, type PowerStatus } from "#power/contract";

const IOKIT = "/System/Library/Frameworks/IOKit.framework/IOKit";
const CORE_GRAPHICS =
  "/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics";
const FOUNDATION = "/System/Library/Frameworks/Foundation.framework/Foundation";

const UTF8_ENCODING = 0x08000100;
const CF_NUMBER_SINT32 = 3;
/** Longest power source key or value text read back; IOPS strings are short fixed names. */
const TEXT_BUFFER_BYTES = 128;
/** `kCGEventSourceStateCombinedSessionState`: input from every source in the login session. */
const COMBINED_SESSION_STATE = 0;
/** `kCGAnyInputEventType`: the time since the latest event of any input type. */
const ANY_INPUT_EVENT_TYPE = 0xffffffff;
/** Largest value the contract accepts for the remaining time estimate. */
const MAX_REMAINING_SECONDS = 0xfffffffe;

/** IOPSKeys.h and IOPowerSources.h string values, spelled as the framework defines them. */
const SOURCE_STATE_AC = "AC Power";
const SOURCE_STATE_BATTERY = "Battery Power";
const SOURCE_TYPE_INTERNAL_BATTERY = "InternalBattery";
const KEY_TYPE = "Type";
const KEY_IS_PRESENT = "Is Present";
const KEY_IS_CHARGING = "Is Charging";
const KEY_CURRENT_CAPACITY = "Current Capacity";
const KEY_MAX_CAPACITY = "Max Capacity";

/** Bun types a returned `ptr` as a number or a bigint address. */
type NativePointer = Pointer | bigint;

type InternalBattery = Pick<
  PowerStatus,
  "batteryPresent" | "charging" | "batteryPercent"
>;

function failure(message: string): never {
  throw new BunawayError({
    code: "INTERNAL",
    message,
  });
}

const closeLibrary = (library: { close(): void }) => library.close();

/** Open the system frameworks the queries read; `owner` releases every handle in reverse order. */
function openLibraries(owner: ResourceOwner) {
  const core = owner.acquire(
    () =>
      dlopen(COREFOUNDATION_PATH, {
        ...pick(
          COREFOUNDATION,
          "CFDictionaryGetValue",
          "CFNumberGetValue",
          "CFRelease",
          "CFStringCreateWithCString",
        ),
        CFArrayGetCount: {
          args: [
            "ptr",
          ],
          returns: "i64",
        },
        CFArrayGetValueAtIndex: {
          args: [
            "ptr",
            "i64",
          ],
          returns: "ptr",
        },
        CFBooleanGetTypeID: {
          args: [],
          returns: "u64",
        },
        CFBooleanGetValue: {
          args: [
            "ptr",
          ],
          returns: "bool",
        },
        CFGetTypeID: {
          args: [
            "ptr",
          ],
          returns: "u64",
        },
        CFNumberGetTypeID: {
          args: [],
          returns: "u64",
        },
        CFStringGetCString: {
          args: [
            "ptr",
            "ptr",
            "i64",
            "u32",
          ],
          returns: "bool",
        },
        CFStringGetTypeID: {
          args: [],
          returns: "u64",
        },
      } as const),
    closeLibrary,
  );
  const iokit = owner.acquire(
    () =>
      dlopen(IOKIT, {
        IOPSCopyPowerSourcesInfo: {
          args: [],
          returns: "ptr",
        },
        IOPSCopyPowerSourcesList: {
          args: [
            "ptr",
          ],
          returns: "ptr",
        },
        IOPSGetPowerSourceDescription: {
          args: [
            "ptr",
            "ptr",
          ],
          returns: "ptr",
        },
        IOPSGetProvidingPowerSourceType: {
          args: [
            "ptr",
          ],
          returns: "ptr",
        },
        IOPSGetTimeRemainingEstimate: {
          args: [],
          returns: "f64",
        },
      } as const),
    closeLibrary,
  );
  const coreGraphics = owner.acquire(
    () =>
      dlopen(CORE_GRAPHICS, {
        CGEventSourceSecondsSinceLastEventType: {
          args: [
            "i32",
            "u32",
          ],
          returns: "f64",
        },
      } as const),
    closeLibrary,
  );
  // Foundation must be loaded before the runtime can resolve NSProcessInfo by name.
  owner.acquire(
    () =>
      dlopen(FOUNDATION, {
        NSClassFromString: {
          args: [
            "ptr",
          ],
          returns: "ptr",
        },
      } as const),
    closeLibrary,
  );
  const runtime = owner.acquire(
    () =>
      dlopen(OBJC_PATH, {
        ...pick(OBJC_RUNTIME, "objc_getClass", "sel_registerName"),
        objc_msgSend: {
          args: [
            "ptr",
            "ptr",
          ],
          returns: "ptr",
        },
      } as const),
    closeLibrary,
  );
  // The same entry point returns a BOOL in the low byte; Bun reads that shape only as `bool`.
  const booleanRuntime = owner.acquire(
    () =>
      dlopen(OBJC_PATH, {
        objc_msgSend: {
          args: [
            "ptr",
            "ptr",
          ],
          returns: "bool",
        },
      } as const),
    closeLibrary,
  );
  const types = {
    boolean: core.symbols.CFBooleanGetTypeID(),
    number: core.symbols.CFNumberGetTypeID(),
    string: core.symbols.CFStringGetTypeID(),
  };
  const key = (name: string): NativePointer => {
    const created = owner.acquire(
      () => core.symbols.CFStringCreateWithCString(null, name, UTF8_ENCODING),
      (string) => {
        if (string) {
          core.symbols.CFRelease(string);
        }
      },
    );
    return created ?? failure(`macOS power key is unavailable: ${name}.`);
  };
  return {
    core,
    iokit,
    coreGraphics,
    runtime,
    booleanRuntime,
    text: Buffer.alloc(TEXT_BUFFER_BYTES),
    types,
    keys: {
      type: key(KEY_TYPE),
      present: key(KEY_IS_PRESENT),
      charging: key(KEY_IS_CHARGING),
      current: key(KEY_CURRENT_CAPACITY),
      max: key(KEY_MAX_CAPACITY),
    },
  };
}

type Libraries = ReturnType<typeof openLibraries>;

/** A CFString as JavaScript text, or null for a missing or differently typed value. */
function stringOf(libs: Libraries, value: NativePointer | null): string | null {
  const { core, text, types } = libs;
  if (!value || core.symbols.CFGetTypeID(value) !== types.string) {
    return null;
  }
  if (
    !core.symbols.CFStringGetCString(
      value,
      ptr(text),
      TEXT_BUFFER_BYTES,
      UTF8_ENCODING,
    )
  ) {
    return null;
  }
  const end = text.indexOf(0);
  return text.toString("utf8", 0, end < 0 ? TEXT_BUFFER_BYTES : end);
}

function booleanOf(
  libs: Libraries,
  dictionary: NativePointer,
  key: NativePointer,
): boolean | null {
  const { core, types } = libs;
  const value = core.symbols.CFDictionaryGetValue(dictionary, key);
  if (!value || core.symbols.CFGetTypeID(value) !== types.boolean) {
    return null;
  }
  return core.symbols.CFBooleanGetValue(value);
}

function integerOf(
  libs: Libraries,
  dictionary: NativePointer,
  key: NativePointer,
): number | null {
  const { core, types } = libs;
  const value = core.symbols.CFDictionaryGetValue(dictionary, key);
  if (!value || core.symbols.CFGetTypeID(value) !== types.number) {
    return null;
  }
  const result = new Int32Array(1);
  return core.symbols.CFNumberGetValue(value, CF_NUMBER_SINT32, ptr(result))
    ? (result[0] ?? null)
    : null;
}

/** Percent of the battery capacity, or null when the capacities are missing or unusable. */
function percentOf(current: number | null, max: number | null): number | null {
  if (current === null || max === null || max <= 0) {
    return null;
  }
  return Math.max(0, Math.min(100, Math.round((current / max) * 100)));
}

/** Present, charging and percent of one internal battery description. */
function batteryOf(
  libs: Libraries,
  description: NativePointer,
): InternalBattery {
  const { keys } = libs;
  const present = booleanOf(libs, description, keys.present);
  if (present === false) {
    return {
      batteryPresent: false,
      charging: false,
      batteryPercent: null,
    };
  }
  return {
    batteryPresent: present,
    charging: booleanOf(libs, description, keys.charging),
    batteryPercent: percentOf(
      integerOf(libs, description, keys.current),
      integerOf(libs, description, keys.max),
    ),
  };
}

/** Whether a power source description of the snapshot is the internal battery. */
function isInternalBattery(
  libs: Libraries,
  description: NativePointer,
): boolean {
  const type = libs.core.symbols.CFDictionaryGetValue(
    description,
    libs.keys.type,
  );
  return stringOf(libs, type) === SOURCE_TYPE_INTERNAL_BATTERY;
}

/** The first internal battery of the snapshot, or the "no battery" answer. */
function findBattery(
  libs: Libraries,
  snapshot: NativePointer,
): InternalBattery {
  const { core, iokit } = libs;
  const list = iokit.symbols.IOPSCopyPowerSourcesList(snapshot);
  if (!list) {
    return {
      batteryPresent: null,
      charging: null,
      batteryPercent: null,
    };
  }
  try {
    const count = Number(core.symbols.CFArrayGetCount(list));
    for (let index = 0; index < count; index++) {
      const source = core.symbols.CFArrayGetValueAtIndex(list, index);
      if (!source) {
        continue;
      }
      // Get rule: the description belongs to the snapshot and must not be released.
      const description = iokit.symbols.IOPSGetPowerSourceDescription(
        snapshot,
        source,
      );
      if (description && isInternalBattery(libs, description)) {
        return batteryOf(libs, description);
      }
    }
    return {
      batteryPresent: false,
      charging: false,
      batteryPercent: null,
    };
  } finally {
    core.symbols.CFRelease(list);
  }
}

/** Low Power Mode, the macOS counterpart of the battery saver flag. */
function isLowPowerMode(libs: Libraries): boolean {
  const { runtime, booleanRuntime } = libs;
  const processInfoClass = runtime.symbols.objc_getClass("NSProcessInfo");
  const processInfoSelector = runtime.symbols.sel_registerName("processInfo");
  const flagSelector = runtime.symbols.sel_registerName(
    "isLowPowerModeEnabled",
  );
  if (!processInfoClass || !processInfoSelector || !flagSelector) {
    return failure("macOS NSProcessInfo is unavailable.");
  }
  // The shared instance is not copied, so no autorelease pool is needed.
  const processInfo = runtime.symbols.objc_msgSend(
    processInfoClass,
    processInfoSelector,
  );
  if (!processInfo) {
    return failure("macOS NSProcessInfo returned no shared instance.");
  }
  return booleanRuntime.symbols.objc_msgSend(processInfo, flagSelector);
}

/** Seconds the battery is expected to last, or null when macOS has no estimate. */
function batteryRemainingSeconds(libs: Libraries): number | null {
  // Negative values are the "unknown" and "unlimited" markers, not durations.
  const estimate = libs.iokit.symbols.IOPSGetTimeRemainingEstimate();
  if (!Number.isFinite(estimate) || estimate < 0) {
    return null;
  }
  return Math.min(Math.floor(estimate), MAX_REMAINING_SECONDS);
}

function powerSourceOf(state: string | null): PowerStatus["source"] {
  if (state === SOURCE_STATE_AC) {
    return "ac";
  }
  return state === SOURCE_STATE_BATTERY ? "battery" : "unknown";
}

function readStatus(libs: Libraries): PowerStatus {
  const { core, iokit } = libs;
  const snapshot = iokit.symbols.IOPSCopyPowerSourcesInfo();
  if (!snapshot) {
    return failure("macOS power source information is unavailable.");
  }
  try {
    const source = powerSourceOf(
      stringOf(libs, iokit.symbols.IOPSGetProvidingPowerSourceType(snapshot)),
    );
    return {
      source,
      ...findBattery(libs, snapshot),
      batterySaver: isLowPowerMode(libs),
      remainingSeconds:
        source === "battery" ? batteryRemainingSeconds(libs) : null,
      // macOS reports no full-charge duration estimate.
      fullLifeSeconds: null,
    };
  } finally {
    core.symbols.CFRelease(snapshot);
  }
}

function readIdleSeconds(libs: Libraries): number {
  const seconds =
    libs.coreGraphics.symbols.CGEventSourceSecondsSinceLastEventType(
      COMBINED_SESSION_STATE,
      ANY_INPUT_EVENT_TYPE,
    );
  if (!Number.isFinite(seconds) || seconds < 0) {
    return failure("macOS returned an invalid input idle time.");
  }
  return Math.min(Math.floor(seconds), MAX_IDLE_SECONDS);
}

/**
 * Bindings for the macOS power queries. Every library handle and CoreFoundation key string has one
 * owner, released in reverse order by `dispose`; reads return copied JavaScript values and release
 * every CoreFoundation object they copy. Nothing here needs the main thread: IOPowerSources,
 * CGEventSource and NSProcessInfo may be called from any thread.
 */
export function createMacosPower() {
  const owner = new ResourceOwner("macOS power adapter cleanup failed.");
  const libs = openLibraries(owner);
  return {
    status: () => readStatus(libs),
    idle: () => readIdleSeconds(libs),
    dispose: () => owner.dispose(),
  };
}
