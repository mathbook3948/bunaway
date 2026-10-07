import type { HostInput, HostOperation, HostOutput, JsonValue } from "@bunaway/protocol";
import { currentHost } from "./host-context.ts";

async function call<K extends HostOperation>(
  operation: K,
  payload: HostInput<K>,
): Promise<HostOutput<K>> {
  return currentHost().call(operation, payload);
}

export const storage = Object.freeze({
  readText(input: HostInput<"storage.readText">): Promise<string> {
    return call("storage.readText", input);
  },
  writeText(input: HostInput<"storage.writeText">): Promise<null> {
    return call("storage.writeText", input);
  },
});

type LogLevel = HostInput<"log.write">["level"];

function writeLog(level: LogLevel, message: string, details?: JsonValue): Promise<null> {
  return call("log.write", { level, message, ...(details === undefined ? {} : { details }) });
}

export const log = Object.freeze({
  write(input: HostInput<"log.write">): Promise<null> {
    return call("log.write", input);
  },
  debug(message: string, details?: JsonValue): Promise<null> {
    return writeLog("debug", message, details);
  },
  info(message: string, details?: JsonValue): Promise<null> {
    return writeLog("info", message, details);
  },
  warn(message: string, details?: JsonValue): Promise<null> {
    return writeLog("warn", message, details);
  },
  error(message: string, details?: JsonValue): Promise<null> {
    return writeLog("error", message, details);
  },
});

export function capabilities(): Promise<HostOutput<"capabilities.get">> {
  return call("capabilities.get", null);
}
