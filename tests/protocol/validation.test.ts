import { expect, test } from "bun:test";
import {
  parseMessage,
  parseProcessFrame,
  MAX_MESSAGE_BYTES,
  serializeMessage,
  serializeProcessFrame,
  type Message,
  validateValue,
} from "../../packages/protocol/src/index.ts";
import { parse } from "../../packages/protocol/src/validation.ts";
import { validationCases } from "./validation-cases.ts";

test("receive size uses original JSON while sending bounds serialized JSON", () => {
  const numbers = Array<number>(50000).fill(1e20);
  const payload = `[${Array<string>(50000).fill("1e20").join(",")}]`;
  const message = `{"kind":"invoke","protocol":{"major":1,"minor":0},"id":"compact","command":"probe.echo","payload":${payload}}`;
  const processFrame = `{"kind":"web","ipc":{"major":1,"minor":0},"runtime":{"id":"probe","generation":"1"},"context":"probe-view","payload":${message}}`;
  expect(Buffer.byteLength(processFrame)).toBeLessThan(MAX_MESSAGE_BYTES);
  expect(Buffer.byteLength(JSON.stringify(JSON.parse(processFrame)))).toBeGreaterThan(
    MAX_MESSAGE_BYTES,
  );
  const parsed = parseProcessFrame(processFrame);
  const web = parseMessage(message);
  if (parsed.kind !== "web" || parsed.payload.kind !== "invoke" || web.kind !== "invoke")
    throw new Error("Expected request");
  expect(parsed.payload.payload).toEqual(numbers);
  expect(web.payload).toEqual(numbers);
  expect(validateValue({}, web.payload)).toEqual(numbers);
  expect(() => serializeProcessFrame(parsed)).toThrow("Invalid protocol data.");
  expect(() => serializeMessage(web)).toThrow("Invalid protocol data.");
  for (const invalid of ["1e999", '"\\ud800"']) {
    expect(() =>
      parse({}, `[${Array<string>(50000).fill("1e20").join(",")},${invalid}]`),
    ).toThrow();
  }
});

test("value validation still bounds repeated subtrees without a serialization size check", () => {
  let value: unknown = 1e20;
  for (let i = 0; i < 32; i++) value = { left: value, right: value };
  expect(() => validateValue({}, value)).toThrow("Invalid protocol data.");
});

test("combined keywords, JSON equality and Unicode lengths match the shared cases", () => {
  for (const { name, schema, value, accepted } of validationCases) {
    if (accepted) expect(validateValue(schema, value), name).toEqual(value);
    else expect(() => validateValue(schema, value), name).toThrow();
  }
});

test("unpaired surrogates fail before IPC serialization and after JSON parsing", () => {
  for (const { value, accepted } of validationCases.filter(
    (item) => item.name.includes("surrogate") || item.name === "sliced emoji",
  )) {
    const frame: Message = {
      kind: "invoke",
      protocol: { major: 1, minor: 0 },
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
