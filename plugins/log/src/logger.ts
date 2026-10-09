import type { JsonValue, NativeInvokeOptions } from "@bunaway/plugin";
import type { LogInput } from "./index.ts";

/** Build level-specific helpers around the plugin's typed write operation. */
export function createLog(
  write: (input: LogInput, options?: NativeInvokeOptions) => Promise<null>,
) {
  // Keep the level in the operation payload so callers cannot log an untyped level.
  const writeLog = (
    level: LogInput["level"],
    message: string,
    details?: JsonValue,
    options?: NativeInvokeOptions,
  ) =>
    write(
      {
        level,
        message,
        ...(details === undefined
          ? {}
          : {
              details,
            }),
      },
      options,
    );

  return Object.freeze({
    write,
    debug(message: string, details?: JsonValue, options?: NativeInvokeOptions) {
      return writeLog("debug", message, details, options);
    },
    info(message: string, details?: JsonValue, options?: NativeInvokeOptions) {
      return writeLog("info", message, details, options);
    },
    warn(message: string, details?: JsonValue, options?: NativeInvokeOptions) {
      return writeLog("warn", message, details, options);
    },
    error(message: string, details?: JsonValue, options?: NativeInvokeOptions) {
      return writeLog("error", message, details, options);
    },
  });
}
