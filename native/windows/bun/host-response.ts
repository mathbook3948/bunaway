import {
  BunawayError,
  type HostResponse,
  type JsonValue,
  serializeHostResponse,
} from "@bunaway/protocol";

const internal = (): HostResponse => ({
  kind: "error",
  error: {
    code: "INTERNAL",
    message: "Host operation failed.",
  },
});

/** Runs the operation once and converts execution or serialization failures to a bounded protocol error response. */
export function hostResponse(execute: () => JsonValue): HostResponse {
  try {
    const response = {
      kind: "result",
      payload: execute(),
    } as const;
    serializeHostResponse(response);
    return response;
  } catch (error) {
    const response: HostResponse =
      error instanceof BunawayError
        ? {
            kind: "error",
            error: {
              code: error.code,
              message: error.message,
            },
          }
        : internal();
    try {
      serializeHostResponse(response);
      return response;
    } catch {
      return internal();
    }
  }
}
