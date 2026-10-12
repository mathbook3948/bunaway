import type { PowerStatus } from "./contract.ts";

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
  return {
    source: ac === 0 ? "battery" : ac === 1 ? "ac" : "unknown",
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
/** GetLastInputInfo and GetTickCount are DWORD milliseconds and wrap together every 49.7 days. */
export function idleSeconds(now: number, lastInput: number): number {
  return Math.floor(((now - lastInput) >>> 0) / 1000);
}
