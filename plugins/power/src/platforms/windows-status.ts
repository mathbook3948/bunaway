import type { PowerCpuSpeedLimit, PowerStatus } from "#power/contract";

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
/**
 * Decode an array of PROCESSOR_POWER_INFORMATION into the lowest MhzLimit / MaxMhz percentage,
 * the same reduction Chromium uses for Electron getCPUSpeedLimit. Entries with MaxMhz 0 carry
 * no ratio and are skipped; without any usable entry there is nothing to report, so it throws.
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
  let lowest: number | undefined;
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
    lowest = lowest === undefined ? percent : Math.min(lowest, percent);
  }
  if (lowest === undefined) {
    throw new Error("No processor reported a nonzero MaxMhz.");
  }
  return {
    speedLimitPercent: lowest,
  };
}
/** GetLastInputInfo and GetTickCount are DWORD milliseconds and wrap together every 49.7 days. */
export function idleSeconds(now: number, lastInput: number): number {
  return Math.floor(((now - lastInput) >>> 0) / 1000);
}
