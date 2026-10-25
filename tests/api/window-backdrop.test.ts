import { expect, test } from "bun:test";
import { backdropIgnored } from "#native/windows/bun/window-backdrop";

const E_INVALIDARG = 0x80070057 | 0;
const E_HANDLE = 0x80070006 | 0;

test("E_INVALIDARG on a Windows build before 22H2 is the documented no-effect case", () => {
  expect(backdropIgnored(E_INVALIDARG, 19045)).toBe(true);
  expect(backdropIgnored(E_INVALIDARG, 22000)).toBe(true);
  expect(backdropIgnored(E_INVALIDARG, 22620)).toBe(true);
});

test("E_INVALIDARG on a build that knows the attribute is a real rejection", () => {
  expect(backdropIgnored(E_INVALIDARG, 22621)).toBe(false);
  expect(backdropIgnored(E_INVALIDARG, 26100)).toBe(false);
  expect(backdropIgnored(E_INVALIDARG, Number.POSITIVE_INFINITY)).toBe(false);
});

test("any other failing HRESULT is never ignored", () => {
  expect(backdropIgnored(E_HANDLE, 19045)).toBe(false);
  expect(backdropIgnored(E_HANDLE, 26100)).toBe(false);
});
