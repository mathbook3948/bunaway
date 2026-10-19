import { expect, test } from "bun:test";
import { WIN32_ERROR_UNKNOWN, win32CallError } from "@bunaway/plugin/win32";

const ERROR_ALREADY_EXISTS = 183;

test("a successful call reports no error and never reads it", () => {
  let reads = 0;
  const code = win32CallError(
    () => 1,
    () => {
      reads++;
      return 5;
    },
  );
  expect(code).toBe(0);
  expect(reads).toBe(0);
});

test("a failed call reports the error it left without repeating the call", () => {
  let calls = 0;
  const code = win32CallError(
    () => {
      calls++;
      return 0;
    },
    () => ERROR_ALREADY_EXISTS,
  );
  expect(code).toBe(ERROR_ALREADY_EXISTS);
  expect(calls).toBe(1);
});

test("an overwritten error is read again after the call is repeated", () => {
  let calls = 0;
  let error = 0;
  const code = win32CallError(
    () => {
      calls++;
      error = calls === 1 ? 0 : ERROR_ALREADY_EXISTS;
      return 0;
    },
    () => error,
  );
  expect(code).toBe(ERROR_ALREADY_EXISTS);
  expect(calls).toBe(2);
});

test("a call that succeeds when repeated reports no error", () => {
  let calls = 0;
  const code = win32CallError(
    () => (++calls === 1 ? 0 : 1),
    () => 0,
  );
  expect(code).toBe(0);
  expect(calls).toBe(2);
});

test("a failure that never leaves a readable error is still reported as a failure", () => {
  const code = win32CallError(
    () => 0n,
    () => 0,
  );
  expect(code).toBe(WIN32_ERROR_UNKNOWN);
});
