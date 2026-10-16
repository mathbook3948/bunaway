import { expect, test } from "bun:test";
import type { HostContext } from "@bunaway/protocol";
import { NativeRequests } from "#native/host-api/bun/native-requests";
import { composePolledObservers } from "#native/host-api/bun/polled-observers";

test("every composed observer receives each packet in order", () => {
  const seen: string[] = [];
  const observe = composePolledObservers(
    (packet) => seen.push(`first:${packet.kind}`),
    (packet) => seen.push(`second:${packet.kind}`),
  );
  observe({
    kind: "shutdown",
  });
  observe({
    kind: "cancel-context",
    context: "ctx" as HostContext,
  });
  expect(seen).toEqual([
    "first:shutdown",
    "second:shutdown",
    "first:cancel-context",
    "second:cancel-context",
  ]);
});

test("a throwing dialog observer still lets modal interruption run and is rethrown", () => {
  const requests = new NativeRequests();
  const context = "menu" as HostContext;
  const signal = requests.begin("popup", context);
  let interrupted = 0;
  requests.onModalInterrupt(signal, () => {
    interrupted++;
  });
  const failure = new Error("dialog observer failed");
  const observe = composePolledObservers(
    () => {
      throw failure;
    },
    (packet) => requests.interruptModal(packet),
  );
  expect(() =>
    observe({
      kind: "cancel",
      requestId: "popup",
      context,
    }),
  ).toThrow(failure);
  expect(interrupted).toBe(1);
  expect(() =>
    observe({
      kind: "shutdown",
    }),
  ).toThrow(failure);
  expect(interrupted).toBe(2);
});

test("several observer failures are aggregated after all observers ran", () => {
  const first = new Error("first");
  const second = new Error("second");
  let reached = false;
  const observe = composePolledObservers(
    () => {
      throw first;
    },
    () => {
      reached = true;
    },
    () => {
      throw second;
    },
  );
  let thrown: unknown;
  try {
    observe({
      kind: "shutdown",
    });
  } catch (error) {
    thrown = error;
  }
  expect(reached).toBe(true);
  expect(thrown).toBeInstanceOf(AggregateError);
  expect((thrown as AggregateError).errors).toEqual([
    first,
    second,
  ]);
});
