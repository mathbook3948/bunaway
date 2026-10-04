import { expect, test } from "bun:test";
import {
  parseMessage,
  serializeMessage,
  type Message,
  validateValue,
} from "../../packages/protocol/src/index.ts";
import { validationCases } from "./validation-cases.ts";

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
