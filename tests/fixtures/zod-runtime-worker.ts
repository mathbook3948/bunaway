import { parentPort } from "node:worker_threads";
import { defineNativePlugin } from "@bunaway/plugin";
import { NativeRegistry } from "@bunaway/protocol";
import { z } from "zod";

let inputCalls = 0;
let outputCalls = 0;
const plugin = defineNativePlugin({
  name: "worker",
  operations: {
    increment: {
      input: z.number().transform((value) => {
        inputCalls++;
        return value + 1;
      }),
      output: z.number().transform((value) => {
        outputCalls++;
        return value + 10;
      }),
    },
  },
  platforms: {
    windows: {
      thread: "worker",
      create: () => ({
        execute: (_name, input) => input,
        dispose() {},
      }),
    },
  },
});
const registration = JSON.parse(JSON.stringify(plugin._definition));
const registry = new NativeRegistry([
  registration,
]);
const adapter = plugin._definition.nativePlatforms.windows?.create({
  dataRoot: ".",
  capabilities: [],
});
if (!adapter || !parentPort) {
  throw new Error("Missing worker setup");
}
parentPort.on("message", async (request) => {
  const call = registry.validateCall(request);
  const value = registry.validateOutput(
    call.operation,
    await adapter.execute(call.operation, call.payload, "test"),
  );
  parentPort?.postMessage({
    value,
    inputCalls,
    outputCalls,
    registration: registration.native,
  });
});
