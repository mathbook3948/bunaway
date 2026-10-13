/** Registry preferences use 0/1; absent or unexpected values remain unknown. */
export function booleanPreference(value: number | null): boolean | null {
  if (value === 0) {
    return false;
  }
  if (value === 1) {
    return true;
  }
  return null;
}
/** Format Win32 COLORREF (BGR bytes) as an RGB CSS color. */
export function colorRef(value: number): string {
  const red = value & 0xff;
  const green = (value >>> 8) & 0xff;
  const blue = (value >>> 16) & 0xff;
  return `#${((red << 16) | (green << 8) | blue).toString(16).padStart(6, "0")}`;
}
