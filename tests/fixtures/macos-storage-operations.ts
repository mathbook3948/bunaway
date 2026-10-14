import { BunawayError, type JsonValue } from "@bunaway/plugin";
import { storageOperations as macosOperations } from "../../plugins/storage/src/operations.ts";
import type { MacosStorage } from "../../plugins/storage/src/platforms/macos.ts";

/** Exercise declared native handlers; SDK parsing and default resolution are covered separately. */
export function executeMacosStorage(
  storage: MacosStorage,
  operation: string,
  input: JsonValue,
): JsonValue {
  const name = operation.slice("storage.".length);
  const definition: unknown = Reflect.get(macosOperations, name);
  const handler: unknown =
    definition && typeof definition === "object"
      ? Reflect.get(definition, "handler")
      : undefined;
  if (
    !operation.startsWith("storage.") ||
    !Object.hasOwn(macosOperations, name) ||
    typeof handler !== "function"
  ) {
    throw new BunawayError({
      code: "UNSUPPORTED",
      message: "Unknown storage operation.",
    });
  }
  // Declared storage handlers return JSON; this fixture deliberately bypasses SDK parsing.
  return handler(input, {
    instance: storage,
    source: "native-test",
  }) as JsonValue;
}
