import { BunawayError } from "@bunaway/protocol";
import type { z } from "zod";
import { MAX_HEADER_BYTES, type requestInputSchema } from "#network/contract";
/** The response headers as pairs, failing when they exceed the count or byte limit of the contract. */
export function responseHeaders(response: Response): [
  string,
  string,
][] {
  const headers = [
    ...response.headers.entries(),
  ];
  if (
    headers.length > 64 ||
    headers.reduce(
      (bytes, [name, value]) =>
        bytes + Buffer.byteLength(name) + Buffer.byteLength(value),
      0,
    ) > MAX_HEADER_BYTES
  ) {
    throw new BunawayError({
      code: "INTERNAL",
      message: "Response headers exceed the limit.",
    });
  }
  return headers;
}
/**
 * Read a response body of at most `maxBytes`, failing when it is longer, and return the status,
 * headers and base64 body. The reader is always cancelled and released. `onChunk` runs after each
 * body chunk, for callers that treat a slow body as progress.
 */
export async function readBoundedResponse(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
  onChunk?: () => void,
) {
  const reader = response.body?.getReader();
  try {
    const headers = responseHeaders(response);
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    if (reader) {
      while (true) {
        signal.throwIfAborted();
        const result = await reader.read();
        if (result.done) {
          break;
        }
        bytes += result.value.byteLength;
        if (bytes > maxBytes) {
          throw new BunawayError({
            code: "INTERNAL",
            message: "Response body exceeds the limit.",
          });
        }
        chunks.push(result.value);
        onChunk?.();
      }
    }
    return {
      status: response.status,
      headers,
      bodyBase64: Buffer.concat(chunks, bytes).toString("base64"),
    };
  } finally {
    // Cancelling an already-consumed reader is safe. Aborting fetch also stops a blocked read.
    if (reader) {
      try {
        await reader.cancel();
      } finally {
        reader.releaseLock();
      }
    }
  }
}
/** Read a bounded, decompressed response. Redirects are returned to the app for a new access check. */
export async function request(
  input: z.output<typeof requestInputSchema>,
  signal: AbortSignal,
  proxy?: string,
) {
  const response = await fetch(input.url, {
    ...(proxy === undefined
      ? {}
      : {
          proxy,
        }),
    method: input.method,
    headers: input.headers,
    ...(input.bodyBase64 === undefined
      ? {}
      : {
          body: Buffer.from(input.bodyBase64, "base64"),
        }),
    redirect: "manual",
    credentials: "omit",
    signal,
  });
  return readBoundedResponse(response, input.maxResponseBytes, signal);
}
