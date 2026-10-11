import type { Policy } from "@bunaway/protocol";
import { windowsPlugin } from "@bunaway/plugin-windows";

/** Grant window operations for lifecycle fixtures; denial tests choose individual names. */
export function windowPermissions(): Policy["backend"]["permissions"] {
  return windowsPlugin.native.operations.map(({ name }) => name);
}
