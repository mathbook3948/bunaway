import { expect, test } from "bun:test";
import { cornerPreferenceIgnored } from "#native/windows/bun/window-corners";

const E_INVALIDARG = 0x80070057 | 0;
const E_HANDLE = 0x80070006 | 0;

test("E_INVALIDARG on a Windows build before 11 is the documented no-effect case", () => {
  expect(cornerPreferenceIgnored(E_INVALIDARG, 19045)).toBe(true);
  expect(cornerPreferenceIgnored(E_INVALIDARG, 21999)).toBe(true);
});

test("E_INVALIDARG on a build that knows the attribute is a real rejection", () => {
  expect(cornerPreferenceIgnored(E_INVALIDARG, 22000)).toBe(false);
  expect(cornerPreferenceIgnored(E_INVALIDARG, 26100)).toBe(false);
  expect(cornerPreferenceIgnored(E_INVALIDARG, Number.POSITIVE_INFINITY)).toBe(
    false,
  );
});

test("any other failing HRESULT is never ignored", () => {
  expect(cornerPreferenceIgnored(E_HANDLE, 19045)).toBe(false);
  expect(cornerPreferenceIgnored(E_HANDLE, 26100)).toBe(false);
});
