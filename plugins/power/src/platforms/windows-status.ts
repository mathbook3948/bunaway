import {
  MAX_LOGICAL_PROCESSORS,
  type PowerCpuSpeedLimit,
  type PowerStatus,
} from "#power/contract";

/** sizeof(PROCESSOR_POWER_INFORMATION): Number, MaxMhz, CurrentMhz, MhzLimit, MaxIdleState, CurrentIdleState. */
export const PROCESSOR_POWER_INFORMATION_SIZE = 24;

const BATTERY_UNKNOWN = 255;
const NO_BATTERY = 128;
const BATTERY_CHARGING = 8;
const UNKNOWN_SECONDS = 0xffffffff;
/** Decode SYSTEM_POWER_STATUS without mistaking unknown or absent battery data for measurements. */
export function powerStatus(data: Uint8Array): PowerStatus {
  if (data.byteLength !== 12) {
    throw new Error("SYSTEM_POWER_STATUS must contain 12 bytes.");
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const ac = view.getUint8(0);
  const flags = view.getUint8(1);
  const percent = view.getUint8(2);
  const unknownBattery = flags === BATTERY_UNKNOWN;
  const noBattery = !unknownBattery && Boolean(flags & NO_BATTERY);
  const seconds = (offset: number) => {
    const value = view.getUint32(offset, true);
    return noBattery || value === UNKNOWN_SECONDS ? null : value;
  };
  let source: PowerStatus["source"] = "unknown";
  if (ac === 0) {
    source = "battery";
  }
  if (ac === 1) {
    source = "ac";
  }
  return {
    source,
    batteryPresent: unknownBattery ? null : !noBattery,
    charging: unknownBattery
      ? null
      : !noBattery && Boolean(flags & BATTERY_CHARGING),
    batteryPercent: noBattery || percent > 100 ? null : percent,
    batterySaver: view.getUint8(3) === 1,
    remainingSeconds: seconds(4),
    fullLifeSeconds: seconds(8),
  };
}
const STATUS_BUFFER_TOO_SMALL = 0xc0000023;
/**
 * Query processor power information into a buffer sized for processorCount entries. When the
 * call reports STATUS_BUFFER_TOO_SMALL the buffer is doubled (bounded by MAX_LOGICAL_PROCESSORS)
 * and the call is made once more. Any other status, including a second too-small result, is
 * returned for the caller to report.
 */
export function readProcessorPower(
  processorCount: number,
  call: (buffer: Buffer) => number,
): {
  status: number;
  data: Buffer;
} {
  let data = Buffer.alloc(processorCount * PROCESSOR_POWER_INFORMATION_SIZE);
  let status = call(data);
  const grown = Math.min(processorCount * 2, MAX_LOGICAL_PROCESSORS);
  if (status >>> 0 === STATUS_BUFFER_TOO_SMALL && grown > processorCount) {
    data = Buffer.alloc(grown * PROCESSOR_POWER_INFORMATION_SIZE);
    status = call(data);
  }
  return {
    status,
    data,
  };
}
/**
 * Decode an array of PROCESSOR_POWER_INFORMATION into the lowest MhzLimit / MaxMhz percentage,
 * the same reduction Chromium uses for Electron getCPUSpeedLimit. Entries with MaxMhz 0 carry
 * no ratio and are skipped. Without any usable entry (some virtualized hosts report MaxMhz 0
 * everywhere) no limit is known, which is reported as 100, like Electron. A buffer that is empty
 * or not a multiple of the entry size is malformed and throws.
 */
export function cpuSpeedLimit(data: Uint8Array): PowerCpuSpeedLimit {
  if (
    data.byteLength === 0 ||
    data.byteLength % PROCESSOR_POWER_INFORMATION_SIZE !== 0
  ) {
    throw new Error(
      "PROCESSOR_POWER_INFORMATION array must be a non-empty multiple of 24 bytes.",
    );
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let lowest = 100;
  for (
    let offset = 0;
    offset < data.byteLength;
    offset += PROCESSOR_POWER_INFORMATION_SIZE
  ) {
    const maxMhz = view.getUint32(offset + 4, true);
    if (maxMhz === 0) {
      continue;
    }
    const limitMhz = view.getUint32(offset + 12, true);
    const percent = Math.min(100, Math.floor((limitMhz * 100) / maxMhz));
    lowest = Math.min(lowest, percent);
  }
  return {
    speedLimitPercent: lowest,
  };
}
/** GetLastInputInfo and GetTickCount are DWORD milliseconds and wrap together every 49.7 days. */
export function idleSeconds(now: number, lastInput: number): number {
  return Math.floor(((now - lastInput) >>> 0) / 1000);
}
/** WTSINFOEXW: DWORD Level, then the 8-byte aligned WTSINFOEX_LEVEL1_W union member. */
export const WTS_INFO_EX_MIN_BYTES = 20;
const WTS_INFO_EX_LEVEL_1 = 1;
const WTS_INFO_EX_FLAGS_OFFSET = 16;
/** WTS_SESSIONSTATE_LOCK is 0 and WTS_SESSIONSTATE_UNLOCK is 1 since Windows 8. */
const WTS_SESSIONSTATE_LOCK = 0;
const WTS_SESSIONSTATE_UNLOCK = 1;
/**
 * Decode the SessionFlags of a WTSINFOEXW into a lock state. A level other than 1 or a flag value
 * other than lock and unlock (WTS_SESSIONSTATE_UNKNOWN, or the swapped meaning older Windows
 * versions report) is not a state, so it throws instead of reporting an unlocked session.
 */
export function sessionLocked(data: Uint8Array): boolean {
  if (data.byteLength < WTS_INFO_EX_MIN_BYTES) {
    throw new Error("WTSINFOEXW is shorter than its level 1 data.");
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (view.getUint32(0, true) !== WTS_INFO_EX_LEVEL_1) {
    throw new Error("WTSINFOEXW does not carry level 1 data.");
  }
  const flags = view.getUint32(WTS_INFO_EX_FLAGS_OFFSET, true);
  if (flags === WTS_SESSIONSTATE_LOCK) {
    return true;
  }
  if (flags === WTS_SESSIONSTATE_UNLOCK) {
    return false;
  }
  throw new Error("The session lock state is unknown.");
}
