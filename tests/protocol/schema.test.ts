import { expect, test } from "bun:test";
import {
  bootstrapSchema,
  DEFAULT_MAX_PENDING,
  hostCallSchema,
  hostResponseSchema,
  MAX_PENDING_CEILING,
  messageSchema,
  parseBootstrap,
  parseHostResponse,
  parseMessage,
  parsePolicy,
  policySchema,
  processSchema,
  resolveMaxPending,
  serializeHostResponse,
} from "@bunaway/protocol";

test("native schemas are generated from the same definitions as TypeScript", async () => {
  for (const [name, schema] of Object.entries({
    message: messageSchema,
    policy: policySchema,
    bootstrap: bootstrapSchema,
    "host-response": hostResponseSchema,
    process: processSchema,
    "host-call": hostCallSchema,
  })) {
    const file = Bun.file(
      new URL(
        `../../native/host-api/generated/${name}.schema.json`,
        import.meta.url,
      ),
    );
    expect(await file.json()).toEqual(schema);
  }
});

test("bootstrap requires a local absolute entrypoint and rejects WebView messages", () => {
  for (const entrypoint of [
    "C:\\app\\backend.js",
    "/app/backend.js",
  ]) {
    const bootstrap = {
      entrypoint,
      buildId: "test-build",
    };
    expect(parseBootstrap(JSON.stringify(bootstrap))).toEqual(bootstrap);
    expect(() => parseMessage(JSON.stringify(bootstrap))).toThrow();
  }
  for (const entrypoint of [
    "backend.js",
    "https://remote/backend.js",
    "C:backend.js",
    "C:\\bad\u0000.js",
  ]) {
    expect(() =>
      parseBootstrap(
        JSON.stringify({
          entrypoint,
          buildId: "test",
        }),
      ),
    ).toThrow();
  }
});

test("Host API responses correlate out of band and cannot impersonate web IPC", () => {
  const success = {
    kind: "result",
    payload: {
      saved: true,
    },
  } as const;
  const failure = {
    kind: "error",
    error: {
      code: "PERMISSION_DENIED",
      message: "Denied.",
    },
  } as const;
  for (const response of [
    success,
    failure,
  ]) {
    const json = serializeHostResponse(response);
    expect(parseHostResponse(json)).toEqual(response);
    expect(() => parseMessage(json)).toThrow();
    expect(() =>
      parseHostResponse(
        JSON.stringify({
          ...response,
          context: 1,
        }),
      ),
    ).toThrow();
    expect(() =>
      parseHostResponse(
        JSON.stringify({
          ...response,
          id: 1,
        }),
      ),
    ).toThrow();
  }
});

const minimalPolicy = {
  version: 1,
  views: [],
  backend: {
    permissions: [],
  },
};

test("the pending request limit is configurable from the default up to its ceiling", () => {
  expect(DEFAULT_MAX_PENDING).toBe(128);
  expect(MAX_PENDING_CEILING).toBe(1024);
  expect(resolveMaxPending(undefined)).toBe(DEFAULT_MAX_PENDING);
  expect(resolveMaxPending(parsePolicy(JSON.stringify(minimalPolicy)))).toBe(
    DEFAULT_MAX_PENDING,
  );
  for (const maxPending of [
    DEFAULT_MAX_PENDING,
    500,
    MAX_PENDING_CEILING,
  ]) {
    const policy = parsePolicy(
      JSON.stringify({
        ...minimalPolicy,
        maxPending,
      }),
    );
    expect(resolveMaxPending(policy)).toBe(maxPending);
  }
  for (const maxPending of [
    0,
    DEFAULT_MAX_PENDING - 1,
    MAX_PENDING_CEILING + 1,
    256.5,
    "256",
    null,
  ]) {
    expect(() =>
      parsePolicy(
        JSON.stringify({
          ...minimalPolicy,
          maxPending,
        }),
      ),
    ).toThrow();
  }
});

test("a server hello may state the configured pending request limit", () => {
  const hello = {
    kind: "hello" as const,
    protocol: {
      major: 1,
      minor: 0,
    },
    features: [] as string[],
    buildId: "test",
  };
  expect(parseMessage(JSON.stringify(hello))).toEqual(hello);
  expect(
    parseMessage(
      JSON.stringify({
        ...hello,
        maxPending: MAX_PENDING_CEILING,
      }),
    ),
  ).toMatchObject({
    maxPending: MAX_PENDING_CEILING,
  });
  expect(() =>
    parseMessage(
      JSON.stringify({
        ...hello,
        maxPending: MAX_PENDING_CEILING + 1,
      }),
    ),
  ).toThrow();
});
