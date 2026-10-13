/** Convert GUID text to the byte order used by the Windows COM ABI. */
export function guid(value: string) {
  const result = Buffer.from(value.replaceAll("-", ""), "hex");
  result.subarray(0, 4).reverse();
  result.subarray(4, 6).reverse();
  result.subarray(6, 8).reverse();
  return result;
}
