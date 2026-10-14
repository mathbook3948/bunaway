import windows from "@bunaway/plugin-windows";
import type { Policy } from "@bunaway/protocol";

/** Grant window operations for lifecycle fixtures; denial tests choose individual names. */
export function windowPermissions(): Policy["backend"]["permissions"] {
  return windows._definition.native.operations.map(({ name }) => name);
}
