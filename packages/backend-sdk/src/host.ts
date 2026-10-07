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

export const windows = Object.freeze({
  list(): Promise<HostOutput<"windows.list">> {
    return call("windows.list", null);
  },
  create(input: HostInput<"windows.create">): Promise<HostOutput<"windows.create">> {
    return call("windows.create", input);
  },
  recreate(input: HostInput<"windows.recreate">): Promise<HostOutput<"windows.recreate">> {
    return call("windows.recreate", input);
  },
  show(input: HostInput<"windows.show">): Promise<HostOutput<"windows.show">> {
    return call("windows.show", input);
  },
  hide(input: HostInput<"windows.hide">): Promise<HostOutput<"windows.hide">> {
    return call("windows.hide", input);
  },
  focus(input: HostInput<"windows.focus">): Promise<HostOutput<"windows.focus">> {
    return call("windows.focus", input);
  },
  close(input: HostInput<"windows.close">): Promise<HostOutput<"windows.close">> {
    return call("windows.close", input);
  },
  setSize(input: HostInput<"windows.setSize">): Promise<HostOutput<"windows.setSize">> {
    return call("windows.setSize", input);
  },
  setPosition(input: HostInput<"windows.setPosition">): Promise<HostOutput<"windows.setPosition">> {
    return call("windows.setPosition", input);
  },
  setFullscreen(
    input: HostInput<"windows.setFullscreen">,
  ): Promise<HostOutput<"windows.setFullscreen">> {
    return call("windows.setFullscreen", input);
  },
  setCloseConfirmation(
    input: HostInput<"windows.setCloseConfirmation">,
  ): Promise<HostOutput<"windows.setCloseConfirmation">> {
    return call("windows.setCloseConfirmation", input);
  },
});
