import { expect, test } from "bun:test";
import { backdropSupported } from "#native/windows/bun/window-backdrop";

test("a Windows build before 22H2 does not make the DWM call", () => {
  expect(backdropSupported(19045)).toBe(false);
  expect(backdropSupported(22000)).toBe(false);
  expect(backdropSupported(22620)).toBe(false);
});

test("22H2 and later builds make the DWM call", () => {
  expect(backdropSupported(22621)).toBe(true);
  expect(backdropSupported(26100)).toBe(true);
});

test("an unreadable build still makes the call so a failure is reported", () => {
  expect(backdropSupported(Number.POSITIVE_INFINITY)).toBe(true);
});
