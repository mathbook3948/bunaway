import type { NativeEnvironment } from "@bunaway/plugin";
import { AppLog } from "#log/app-log";

/** Keep app-owned log state on the macos I/O worker. */
export function initialize(environment: NativeEnvironment): AppLog {
  return new AppLog(environment.dataRoot);
}
