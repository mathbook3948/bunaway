import { expect, test } from "bun:test";
import { hostResponse } from "#native/host-api/bun/host-response";
import {
  BunawayError,
  MAX_MESSAGE_BYTES,
  parseHostResponse,
} from "@bunaway/protocol";

test("UI and I/O host responses bound both results and plugin errors", () => {
  expect(hostResponse(() => "ok")).toEqual({
    kind: "result",
    payload: "ok",
  });
  expect(hostResponse(() => "x".repeat(MAX_MESSAGE_BYTES - 2))).toEqual({
    kind: "error",
    error: {
      code: "INTERNAL",
      message: "Host operation failed.",
    },
  });
  for (const message of [
    "Denied.",
    "x".repeat(MAX_MESSAGE_BYTES),
    "\uD800",
  ]) {
    const response = hostResponse(() => {
      throw new BunawayError({
        code: "PERMISSION_DENIED",
        message,
      });
    });
    expect(parseHostResponse(JSON.stringify(response))).toEqual(response);
    expect(response.kind === "error" && response.error.code).toBe(
      message === "Denied." ? "PERMISSION_DENIED" : "INTERNAL",
    );
  }
});
