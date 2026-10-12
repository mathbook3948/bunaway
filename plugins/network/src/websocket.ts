import { BunawayError } from "@bunaway/protocol";
import type { z } from "zod";
import { MAX_BODY_BYTES, type networkOperations } from "./contract.ts";

type ExchangeResult = z.output<typeof networkOperations.exchange.output>;
/** Own a socket until its close event, abort, error or bounded receive completion. */
export function exchange(
  input: z.output<typeof networkOperations.exchange.input>,
  signal: AbortSignal,
): Promise<ExchangeResult> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const socket = new WebSocket(input.url);
    socket.binaryType = "arraybuffer";
    const messages: ExchangeResult["messages"] = [];
    let bytes = 0;
    let closing = false;
    let finished = false;
    const finish = (error?: unknown, close?: ExchangeResult["close"]) => {
      if (finished) {
        return;
      }
      finished = true;
      signal.removeEventListener("abort", abort);
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      // terminate releases the TCP connection immediately on cancellation or error.
      if (socket.readyState !== WebSocket.CLOSED) {
        socket.terminate();
      }
      if (error) {
        reject(error);
      } else if (close) {
        resolve({
          messages,
          close,
        });
      }
    };
    const abort = () => finish(signal.reason);
    signal.addEventListener("abort", abort, {
      once: true,
    });
    socket.onopen = () => {
      try {
        for (const text of input.messages) {
          const size = Buffer.byteLength(text);
          if (socket.bufferedAmount + size > MAX_BODY_BYTES) {
            throw new BunawayError({
              code: "BUSY",
              message: "WebSocket send buffer exceeds the limit.",
            });
          }
          socket.send(text);
        }
      } catch (error) {
        finish(error);
      }
    };
    socket.onmessage = (event) => {
      if (finished || closing) {
        return;
      }
      const data: unknown = event.data;
      if (typeof data !== "string" && !(data instanceof ArrayBuffer)) {
        finish(
          new BunawayError({
            code: "INTERNAL",
            message: "Unexpected WebSocket message type.",
          }),
        );
        return;
      }
      bytes +=
        typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
      if (bytes > MAX_BODY_BYTES) {
        finish(
          new BunawayError({
            code: "INTERNAL",
            message: "WebSocket messages exceed the limit.",
          }),
        );
        return;
      }
      const message =
        typeof data === "string"
          ? {
              kind: "text" as const,
              text: data,
            }
          : {
              kind: "binary" as const,
              base64: Buffer.from(data).toString("base64"),
            };
      messages.push(message);
      if (messages.length === input.receiveCount) {
        closing = true;
        socket.close(1000);
      }
    };
    socket.onerror = () =>
      finish(
        new BunawayError({
          code: "INTERNAL",
          message: "WebSocket connection failed.",
        }),
      );
    socket.onclose = (event) =>
      finish(undefined, {
        code: event.code,
        reason: event.reason,
        wasClean: event.wasClean,
      });
  });
}
