import { expect, test } from "bun:test";
import { API_LIMITS, type HostContext } from "@bunaway/protocol";
import { NativeRequests } from "#native/host-api/bun/native-requests";

test("native cancellation releases slots and isolates late completions from a reused id", () => {
  const requests = new NativeRequests();
  const first = "first" as HostContext;
  const second = "second" as HostContext;
  const old = requests.begin("reused", first);
  requests.cancel("reused");
  const current = requests.begin("reused", second);
  expect(old.aborted).toBe(true);
  expect(requests.finish("reused", old)).toBe(false);
  expect(requests.context("reused")).toBe(second);
  for (let index = 1; index < API_LIMITS.maxPending; index++) {
    requests.begin(String(index), first);
  }
  expect(() => requests.begin("overflow", first)).toThrow();
  requests.cancelContext(first);
  expect(current.aborted).toBe(false);
  for (let index = 1; index < API_LIMITS.maxPending; index++) {
    requests.begin(String(index), first);
  }
  requests.cancelAll();
  expect(current.aborted).toBe(true);
  expect(requests.context("reused")).toBeUndefined();
  expect(requests.finish("reused", current)).toBe(false);
  const healthy = requests.begin("healthy", second);
  expect(requests.finish("healthy", healthy)).toBe(true);
  expect(requests.context("healthy")).toBeUndefined();
});
