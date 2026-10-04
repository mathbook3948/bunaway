import { expect, test } from "bun:test";
import {
  bootstrapSchema,
  hostResponseSchema,
  messageSchema,
  policySchema,
  parseBootstrap,
  parseHostResponse,
  parseMessage,
  serializeHostResponse,
} from "../../packages/protocol/src/index.ts";

test("native schemas are generated from the same definitions as TypeScript", async () => {
  for (const [name, schema] of Object.entries({
    message: messageSchema,
    policy: policySchema,
    bootstrap: bootstrapSchema,
    "host-response": hostResponseSchema,
  })) {
    const file = Bun.file(
      new URL(`../../native/host-api/generated/${name}.schema.json`, import.meta.url),
    );
    expect(await file.json()).toEqual(schema);
  }
});

test("bootstrap requires a local absolute entrypoint and rejects WebView messages", () => {
  for (const entrypoint of ["C:\\app\\backend.js", "/app/backend.js"]) {
    const bootstrap = { entrypoint, buildId: "test-build" };
    expect(parseBootstrap(JSON.stringify(bootstrap))).toEqual(bootstrap);
    expect(() => parseMessage(JSON.stringify(bootstrap))).toThrow();
  }
  for (const entrypoint of [
    "backend.js",
    "https://remote/backend.js",
    "C:backend.js",
    "C:\\bad\u0000.js",
  ]) {
    expect(() => parseBootstrap(JSON.stringify({ entrypoint, buildId: "test" }))).toThrow();
  }
});

test("Host API responses correlate out of band and cannot impersonate web IPC", () => {
  const success = { kind: "result", payload: { saved: true } } as const;
  const failure = {
    kind: "error",
    error: { code: "PERMISSION_DENIED", message: "Denied." },
  } as const;
  for (const response of [success, failure]) {
    const json = serializeHostResponse(response);
    expect(parseHostResponse(json)).toEqual(response);
    expect(() => parseMessage(json)).toThrow();
    expect(() => parseHostResponse(JSON.stringify({ ...response, context: 1 }))).toThrow();
    expect(() => parseHostResponse(JSON.stringify({ ...response, id: 1 }))).toThrow();
  }
});
