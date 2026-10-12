import {
  defineNativePlugin,
  type NativeOperationDefinition,
} from "@bunaway/plugin";
import {
  type HostCall,
  type JsonValue,
  validateValue,
} from "@bunaway/protocol";
import { z } from "zod";

/** Exercise the SDK boundary with identity adapters, independently of OS resources. */
export function pluginParsers(
  name: string,
  definitions: Record<string, NativeOperationDefinition>,
) {
  const create = () => ({
    execute: (_name: string, value: JsonValue) => value,
    dispose() {},
  });
  const build = (output: boolean) =>
    defineNativePlugin({
      name,
      operations: Object.fromEntries(
        Object.entries(definitions).map(([key, schema]) => [
          key,
          {
            input: output ? z.unknown() : schema.input,
            output: output ? schema.output : z.unknown(),
          },
        ]),
      ),
      platforms: {
        windows: {
          execution: "io",
          create,
        },
      },
    }).definition.nativePlatforms.windows?.create({
      dataRoot: ".",
      capabilities: [],
    });
  const input = build(false);
  const output = build(true);
  if (!input || !output) {
    throw new Error("Missing fixture adapter.");
  }
  return {
    validateCall(call: HostCall) {
      return {
        ...call,
        payload: input.execute(call.operation, call.payload, "test"),
      };
    },
    validateOutput(name: string, value: unknown) {
      return output.execute(name, validateValue({}, value), "test");
    },
  };
}
