import assert from "node:assert/strict";

/** Check the LOCALE_SISO3166CTRYNAME shape, including three-digit regions such as Caribbean 029. */
export function assertWindowsRegionCode(value: string | null): void {
  if (value !== null) {
    assert.match(value, /^(?:[A-Z]{2}|[0-9]{3})$(?![\s\S])/);
  }
}
