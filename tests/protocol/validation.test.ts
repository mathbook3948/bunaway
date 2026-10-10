import { expect, test } from "bun:test";
import {
  MAX_MESSAGE_BYTES,
  type Message,
  parseMessage,
  parseProcessFrame,
  serializeMessage,
  serializeProcessFrame,
  validateMessage,
  validateValue,
} from "@bunaway/protocol";
import { parse, serialize, utf8Size } from "#protocol/validation";
import { validationCases } from "./validation-cases.ts";

test("message preflight preserves snapshots and exact wire limits without encoding the frame", () => {
  const source: Message = {
    kind: "result",
    protocol: {
      major: 1,
      minor: 0,
    },
    id: "reply",
    payload: {
      text: '한글\n"\\😀',
      number: 1e20,
    },
  };
  const copy = validateMessage(source);
  expect(copy).toEqual(parseMessage(serializeMessage(source)));
  source.payload = null;
  expect(copy).not.toEqual(source);
  const overhead = Buffer.byteLength(
    serializeMessage({
      ...source,
      payload: "",
    }),
  );
  const atLimit = {
    ...source,
    payload: "x".repeat(MAX_MESSAGE_BYTES - overhead),
  };
  expect(serializeMessage(validateMessage(atLimit)).length).toBe(
    MAX_MESSAGE_BYTES,
  );
  expect(() =>
    validateMessage({
      ...atLimit,
      payload: `${atLimit.payload}x`,
    }),
  ).toThrow();
  expect(() =>
    validateMessage({
      ...atLimit,
      payload: "\n".repeat(MAX_MESSAGE_BYTES / 2),
    }),
  ).toThrow();
});

test("fast string accounting preserves escapes, Unicode, byte limits and parsed key isolation", () => {
  for (const value of [
    "a".repeat(131072),
    "é한💡",
    '\u0000\n\r\t"\\',
    "",
  ]) {
    const text = serialize(
      {},
      {
        [value]: value,
      },
    );
    expect(utf8Size(text)).toBe(Buffer.byteLength(text));
    expect(parse({}, text)).toEqual({
      [value]: value,
    });
  }
  const value = parse({}, '{"__proto__":{"polluted":true},"constructor":0}');
  if (value === null || typeof value !== "object") {
    throw new Error("Expected parsed object");
  }
  expect(Object.getPrototypeOf(value)).toBeNull();
  expect(Object.hasOwn(value, "__proto__")).toBe(true);
  expect(() => parse({}, '{"\\ud800":0}')).toThrow();
  expect(serialize({}, "x".repeat(MAX_MESSAGE_BYTES - 2)).length).toBe(
    MAX_MESSAGE_BYTES,
  );
  expect(() => serialize({}, "x".repeat(MAX_MESSAGE_BYTES - 1))).toThrow();
});

test("receive size uses original JSON while sending bounds serialized JSON", () => {
  const numbers = Array<number>(50000).fill(1e20);
  const payload = `[${Array<string>(50000).fill("1e20").join(",")}]`;
  const message = `{"kind":"invoke","protocol":{"major":1,"minor":0},"id":"compact","command":"probe.echo","payload":${payload}}`;
  const processFrame = `{"kind":"web","ipc":{"major":1,"minor":0},"runtime":{"id":"probe","generation":"1"},"context":"probe-view","payload":${message}}`;
  expect(() => validateMessage(parseMessage(message))).toThrow();
  expect(Buffer.byteLength(processFrame)).toBeLessThan(MAX_MESSAGE_BYTES);
  expect(
    Buffer.byteLength(JSON.stringify(JSON.parse(processFrame))),
  ).toBeGreaterThan(MAX_MESSAGE_BYTES);
  const parsed = parseProcessFrame(processFrame);
  const web = parseMessage(message);
  if (
    parsed.kind !== "web" ||
    parsed.payload.kind !== "invoke" ||
    web.kind !== "invoke"
  ) {
    throw new Error("Expected request");
  }
  expect(parsed.payload.payload).toEqual(numbers);
  expect(web.payload).toEqual(numbers);
  expect(validateValue({}, web.payload)).toEqual(numbers);
  expect(() => serializeProcessFrame(parsed)).toThrow("Invalid protocol data.");
  expect(() => serializeMessage(web)).toThrow("Invalid protocol data.");
  for (const invalid of [
    "1e999",
    '"\\ud800"',
  ]) {
    expect(() =>
      parse({}, `[${Array<string>(50000).fill("1e20").join(",")},${invalid}]`),
    ).toThrow();
  }
});

test("value validation still bounds repeated subtrees without a serialization size check", () => {
  let value: unknown = 1e20;
  for (let i = 0; i < 32; i++) {
    value = {
      left: value,
      right: value,
    };
  }
  expect(() => validateValue({}, value)).toThrow("Invalid protocol data.");
});

test("combined keywords, JSON equality and Unicode lengths match the shared cases", () => {
  for (const { name, schema, value, accepted } of validationCases) {
    if (accepted) {
      expect(validateValue(schema, value), name).toEqual(value);
    } else {
      expect(() => validateValue(schema, value), name).toThrow();
    }
  }
});

test("unpaired surrogates fail before IPC serialization and after JSON parsing", () => {
  for (const { value, accepted } of validationCases.filter(
    (item) => item.name.includes("surrogate") || item.name === "sliced emoji",
  )) {
    const frame: Message = {
      kind: "invoke",
      protocol: {
        major: 1,
        minor: 0,
      },
      id: "unicode",
      command: "probe.echo",
      payload: value,
    };
    if (accepted) {
      expect(parseMessage(serializeMessage(frame))).toEqual(frame);
    } else {
      expect(() => serializeMessage(frame)).toThrow();
      expect(() => parseMessage(JSON.stringify(frame))).toThrow();
    }
  }
});
