import { dlopen, ptr } from "bun:ffi";
import { ADVAPI32, pick, wide } from "@bunaway/plugin/win32";
import type { OSMediaAccessStatus, OSMediaType } from "#os/contract";

const HKEY_CURRENT_USER = 0xffffffff80000001n;
const HKEY_LOCAL_MACHINE = 0xffffffff80000002n;
const ERROR_SUCCESS = 0;
const ERROR_FILE_NOT_FOUND = 2;
const ERROR_PATH_NOT_FOUND = 3;
const RRF_RT_REG_SZ = 0x2;
const RRF_SUBKEY_WOW6464KEY = 0x10000;
/** Longest `Value` read: the consent store holds "Allow" or "Deny"; anything longer is unexpected. */
const MAX_VALUE_BYTES = 64;

const CONSENT_STORE =
  "Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\";
/** Consent store key of each device class; the path never contains caller input. */
const CONSENT_KEYS: Record<OSMediaType, string> = {
  camera: `${CONSENT_STORE}webcam`,
  microphone: `${CONSENT_STORE}microphone`,
};

export type ConsentHive = "user" | "machine";

/** What one consent store read found: the string value, no value at all, or a failed or non-string read. */
export type ConsentValue =
  | {
      kind: "value";
      value: string;
    }
  | {
      kind: "missing";
    }
  | {
      kind: "unreadable";
    };

/** The registry read the media access status needs. */
export interface MediaAccessBindings {
  /** `RegGetValueW` of the `Value` string under the device class key of one hive. */
  readConsent(hive: ConsentHive, mediaType: OSMediaType): ConsentValue;
}

/** Open advapi32.dll; the caller owns the returned library and closes it on dispose. */
export function openAdvapi() {
  return dlopen("advapi32.dll", pick(ADVAPI32, "RegGetValueW"));
}

/** Adapt `RegGetValueW` to the narrow interface above. It opens no key handle, so nothing needs closing. */
export function mediaAccessBindings(
  advapi: ReturnType<typeof openAdvapi>,
): MediaAccessBindings {
  return {
    readConsent(hive, mediaType) {
      const subkey = wide(CONSENT_KEYS[mediaType]);
      const name = wide("Value");
      const data = Buffer.alloc(MAX_VALUE_BYTES);
      const size = new Uint32Array([
        data.length,
      ]);
      const result = advapi.symbols.RegGetValueW(
        hive === "user" ? HKEY_CURRENT_USER : HKEY_LOCAL_MACHINE,
        ptr(subkey),
        ptr(name),
        RRF_RT_REG_SZ | RRF_SUBKEY_WOW6464KEY,
        null,
        ptr(data),
        ptr(size),
      );
      if (result === ERROR_FILE_NOT_FOUND || result === ERROR_PATH_NOT_FOUND) {
        return {
          kind: "missing",
        };
      }
      if (result !== ERROR_SUCCESS) {
        return {
          kind: "unreadable",
        };
      }
      // The size includes the terminating NUL.
      return {
        kind: "value",
        value: data
          .subarray(0, Math.max((size[0] ?? 0) - 2, 0))
          .toString("utf16le"),
      };
    },
  };
}

/**
 * The OS privacy setting for a device class, read from the Windows consent store. The
 * device-wide hive (the "allow access on this device" setting; group policy keys are not read)
 * decides first: a `Deny` there is `restricted`. Otherwise the user hive decides: `Allow` is `granted`, `Deny`
 * is `denied` and no stored value is `not-determined`. A failed read or any other value is
 * `unknown`; a missing value is never assumed to be granted. The answer is the system-wide
 * setting only; per-app entries under `NonPackaged` are not consulted.
 */
export function mediaAccessStatus(
  bindings: MediaAccessBindings,
  mediaType: OSMediaType,
): OSMediaAccessStatus {
  const machine = bindings.readConsent("machine", mediaType);
  if (machine.kind === "unreadable") {
    return "unknown";
  }
  if (machine.kind === "value") {
    if (machine.value === "Deny") {
      return "restricted";
    }
    if (machine.value !== "Allow") {
      return "unknown";
    }
  }
  const user = bindings.readConsent("user", mediaType);
  if (user.kind === "missing") {
    return "not-determined";
  }
  if (user.kind === "value" && user.value === "Allow") {
    return "granted";
  }
  if (user.kind === "value" && user.value === "Deny") {
    return "denied";
  }
  return "unknown";
}
