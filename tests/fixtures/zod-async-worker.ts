import { parentPort } from "node:worker_threads";
import {
  defineNativePlugin,
  type NativeOperationDefinition,
} from "@bunaway/plugin";
import type { HostResponse } from "@bunaway/protocol";
import { z } from "zod";
import { hostResponse } from "../../native/host-api/bun/host-response.ts";

if (!parentPort) {
  throw new Error("Missing Worker port");
}
const failure = async () => {
  await Bun.sleep(1);
  throw new Error("private callback failure");
};
const immediateFailure = () => {
  throw new Error("immediate callback failure");
};
const delayed = z.string().refine(failure);
const immediate = z.string().refine(immediateFailure);
const schemas = {
  refine: z.string().refine(async () => {
    throw new Error("private refinement failure");
  }),
  promise: z.string().refine(() => failure()),
  transform: z.string().transform(failure),
  checks: delayed.refine(immediateFailure),
  checkChain: z
    .string()
    .refine(() => new Promise<boolean>(() => {}))
    .refine(failure),
  object: z.object({
    first: delayed,
    second: immediate,
  }),
  array: z.array(
    z
      .string()
      .refine((value) => (value === "first" ? failure() : immediateFailure())),
  ),
  tuple: z.tuple([
    delayed,
    immediate,
  ]),
  union: z.union([
    delayed,
    immediate,
  ]),
  intersection: z.intersection(delayed, immediate),
  record: z.record(
    z.string(),
    z
      .string()
      .refine((value) => (value === "first" ? failure() : immediateFailure())),
  ),
  when: delayed.refine(() => true, {
    when: immediateFailure,
  }),
  never: z.object({
    first: z.string().refine(() => new Promise<boolean>(() => {})),
    second: immediate,
  }),
  nested: z.object({
    value: z.string().refine(failure),
  }),
};
const definitions: Record<string, NativeOperationDefinition> = {};
for (const [name, schema] of Object.entries(schemas)) {
  definitions[`${name}Input`] = {
    input: schema,
    output: z.unknown(),
  };
  definitions[`${name}Output`] = {
    input: z.unknown(),
    output: schema,
  };
}
const plugin = defineNativePlugin({
  name: "async",
  operations: definitions,
  platforms: {
    windows: {
      execution: "ui",
      create: () => ({
        execute: (_name, input) => input,
        executeUI: (_name, input) => input,
        dispose() {},
      }),
    },
  },
});
const adapter = plugin.definition.nativePlatforms.windows?.create({
  dataRoot: ".",
  capabilities: [],
});
if (!adapter?.executeUI) {
  throw new Error("Missing adapter");
}
parentPort.on("message", async (request: string) => {
  if (request === "close") {
    await adapter.dispose();
    parentPort?.close();
    return;
  }
  if (request === "ping") {
    // Give orphan rejections a full event-loop turn before acknowledging Worker health.
    await Bun.sleep(10);
    parentPort?.postMessage({
      kind: "result",
      payload: "alive",
    });
    return;
  }
  const [execution, mode, boundary] = request.split(":");
  const name = `async.${mode}${boundary === "input" ? "Input" : "Output"}`;
  const input = [
    "object",
    "record",
    "never",
  ].includes(mode ?? "")
    ? {
        first: "first",
        second: "second",
      }
    : [
          "array",
          "tuple",
        ].includes(mode ?? "")
      ? [
          "first",
          "second",
        ]
      : mode === "nested"
        ? {
            value: "ok",
          }
        : "ok";
  let response: HostResponse;
  try {
    const value =
      execution === "io"
        ? await adapter.execute(name, input, "test")
        : await adapter.executeUI?.(name, input, "test", {
            requestId: "test",
            permissions: {
              permissions: [],
            },
          });
    response = hostResponse(() => {
      if (value === undefined) {
        throw new Error("Missing UI result");
      }
      return value;
    });
  } catch (error) {
    response = hostResponse(() => {
      throw error;
    });
  }
  parentPort?.postMessage(response);
});
