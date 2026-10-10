import { expect, test } from "bun:test";
import {
  MAX_MESSAGE_BYTES,
  parseMessage,
  parseProcessFrame,
  PROCESS_IPC_VERSION,
  serializeProcessFrame,
} from "@bunaway/protocol";
import { readJsonLines } from "#runtime-bun/process-ipc";

async function lines(parts: Uint8Array[]) {
  async function* chunks() {
    yield* parts;
  }
  return Array.fromAsync(readJsonLines(chunks()));
}

test("host-only envelopes preserve string identities and reject Web bridge input", () => {
  const frame = {
    kind: "host-request",
    ipc: PROCESS_IPC_VERSION,
    runtime: {
      id: "runtime-1",
      generation: "9007199254740993",
    },
    context: "view-1",
    requestId: "9007199254740995",
    operation: "storage.get",
    payload: {
      key: "한글",
    },
  } as const;
  const text = serializeProcessFrame(frame);
  expect(parseProcessFrame(text)).toEqual(frame);
  expect(() => parseMessage(text)).toThrow();
  expect(() =>
    parseProcessFrame(
      JSON.stringify({
        ...frame,
        requestId: 42,
      }),
    ),
  ).toThrow();
  expect(() =>
    parseProcessFrame(
      JSON.stringify({
        ...frame,
        ipc: {
          major: 2,
          minor: 0,
        },
      }),
    ),
  ).toThrow();
  expect(() =>
    parseProcessFrame(
      JSON.stringify({
        ...frame,
        extra: true,
      }),
    ),
  ).toThrow();
});

test("NDJSON handles every UTF-8 split boundary and several frames in one chunk", async () => {
  const bytes = Buffer.from('{"text":"한글 😀"}\n{"number":42}\n');
  for (let at = 1; at < bytes.length; at++) {
    expect(
      await lines([
        bytes.subarray(0, at),
        bytes.subarray(at),
      ]),
    ).toEqual([
      '{"text":"한글 😀"}',
      '{"number":42}',
    ]);
  }
  expect(
    await lines(
      Array.from(
        bytes,
        (byte) =>
          new Uint8Array([
            byte,
          ]),
      ),
    ),
  ).toHaveLength(2);
});

for (const buffer of [
  Buffer.alloc(4).subarray(1, 3),
  new Uint8Array(4).subarray(1, 3),
]) {
  test(`NDJSON copies reused ${buffer.constructor.name} chunks`, async () => {
    async function* chunks() {
      buffer.set([
        49,
        50,
      ]);
      yield buffer;
      buffer.set([
        51,
        52,
      ]);
      yield buffer;
      buffer[0] = 10;
      yield buffer.subarray(0, 1);
    }
    expect(await Array.fromAsync(readJsonLines(chunks()))).toEqual([
      "1234",
    ]);
  });
}

test("NDJSON rejects invalid UTF-8, blank frames, incomplete EOF and byte overflow", async () => {
  for (const parts of [
    [
      Buffer.from([
        255,
        10,
      ]),
    ],
    [
      Buffer.from("\n"),
    ],
    [
      Buffer.from("{"),
    ],
    [
      Buffer.alloc(MAX_MESSAGE_BYTES + 1, 120),
    ],
  ]) {
    await expect(lines(parts)).rejects.toThrow();
  }
  expect(
    await lines([
      Buffer.alloc(MAX_MESSAGE_BYTES, 120),
      Buffer.from("\n"),
    ]),
  ).toHaveLength(1);
});
