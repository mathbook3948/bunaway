import type { NativeAdapter, NativeEnvironment } from "../../../packages/plugin-sdk/src/index.ts";
import type {
  NativePluginContract,
  PermissionMatcher,
} from "../../../packages/protocol/src/index.ts";

export type { NativeAdapter, NativeEnvironment };
export type PackagedPlugin = {
  name: string;
  version: string;
  native: NativePluginContract;
  execution?: "io" | "ui";
  authorization?: () => Promise<{ matches: PermissionMatcher }>;
  operations?: () => Promise<{ createOperations(environment: NativeEnvironment): NativeAdapter }>;
};
// The CLI replaces this table with adapters from direct installed plugin dependencies.
export const packagedPlugins: readonly PackagedPlugin[] = [];
