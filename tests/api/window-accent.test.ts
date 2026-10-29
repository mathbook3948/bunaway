import { expect, test } from "bun:test";
import {
  accentColorRef,
  accentSupported,
} from "#native/windows/bun/window-accent";

test("a Windows build before 11 does not make the DWM call", () => {
  expect(accentSupported(19045)).toBe(false);
  expect(accentSupported(21999)).toBe(false);
});

test("Windows 11 builds make the DWM call", () => {
  expect(accentSupported(22000)).toBe(true);
  expect(accentSupported(26100)).toBe(true);
});

test("an unreadable build still makes the call so a failure is reported", () => {
  expect(accentSupported(Number.POSITIVE_INFINITY)).toBe(true);
});

test("a color is passed as a COLORREF with red in the low byte", () => {
  expect(accentColorRef("#112233")).toBe(0x332211);
  expect(accentColorRef("#ff0000")).toBe(0x0000ff);
  expect(accentColorRef("#000000")).toBe(0);
});

test("null selects the system color marker", () => {
  expect(accentColorRef(null)).toBe(0xffffffff);
});
