import { expect, test } from "bun:test";
import { cornerPreferenceFailure } from "#native/windows/bun/window-corners";

const E_INVALIDARG = 0x80070057 | 0;
const E_HANDLE = 0x80070006 | 0;

test("a success result is never a failure", () => {
  expect(cornerPreferenceFailure(0, 19045)).toBeNull();
  expect(cornerPreferenceFailure(0, 22631)).toBeNull();
});

test("a Windows build before 11 rejecting the unknown attribute counts as done", () => {
  expect(cornerPreferenceFailure(E_INVALIDARG, 19045)).toBeNull();
  expect(cornerPreferenceFailure(E_INVALIDARG, 21999)).toBeNull();
});

test("E_INVALIDARG on a build that knows the attribute is a failure", () => {
  expect(cornerPreferenceFailure(E_INVALIDARG, 22000)?.message).toContain(
    "0x80070057",
  );
  expect(cornerPreferenceFailure(E_INVALIDARG, 26100)).toBeInstanceOf(Error);
});

test("any other failing HRESULT is a failure on every build", () => {
  expect(cornerPreferenceFailure(E_HANDLE, 19045)?.message).toContain(
    "0x80070006",
  );
  expect(cornerPreferenceFailure(E_HANDLE, 26100)).toBeInstanceOf(Error);
});
