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

test("modal interruption matches the active request and context without releasing its slot", () => {
  const requests = new NativeRequests();
  const context = "menu" as HostContext;
  const signal = requests.begin("popup", context);
  let interrupted = 0;
  const unsubscribe = requests.onModalInterrupt(signal, () => {
    interrupted++;
  });
  requests.interruptModal({
    kind: "cancel",
    requestId: "other",
    context,
  });
  requests.interruptModal({
    kind: "cancel",
    requestId: "popup",
    context: "other" as HostContext,
  });
  requests.interruptModal({
    kind: "cancel-context",
    context: "other" as HostContext,
  });
  expect(interrupted).toBe(0);
  requests.interruptModal({
    kind: "cancel",
    requestId: "popup",
    context,
  });
  expect(interrupted).toBe(1);
  expect(signal.aborted).toBe(false);
  expect(requests.context("popup")).toBe(context);
  requests.interruptModal({
    kind: "cancel-context",
    context,
  });
  requests.interruptModal({
    kind: "shutdown",
  });
  expect(interrupted).toBe(3);
  unsubscribe();
  requests.interruptModal({
    kind: "shutdown",
  });
  expect(interrupted).toBe(3);
  requests.cancel("popup");
  expect(signal.aborted).toBe(true);
});

test("shutdown observed before native menu entry also interrupts late registrations", () => {
  const requests = new NativeRequests();
  requests.interruptModal({
    kind: "shutdown",
  });
  let interrupted = 0;
  const unsubscribe = requests.onModalInterrupt(undefined, () => {
    interrupted++;
  });
  expect(interrupted).toBe(1);
  unsubscribe();
  requests.interruptModal({
    kind: "shutdown",
  });
  expect(interrupted).toBe(1);
});
