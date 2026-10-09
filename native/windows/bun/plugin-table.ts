import type {
  NativeAdapter,
  NativeEnvironment,
} from "../../../packages/plugin-sdk/src/index.ts";
import type {
  NativePluginContract,
  PermissionMatcher,
} from "../../../packages/protocol/src/index.ts";

export type { NativeAdapter, NativeEnvironment };

/** A plugin's installed contract and the factories available to each Windows worker. */
export type PackagedPlugin = {
  name: string;
  version: string;
  native: NativePluginContract;
  /** Worker that owns this plugin's native resources and executes its operations. */
  execution?: "io" | "ui";
  /** Lazily load permission-scope matching for registered scoped permissions. */
  authorization?: () => Promise<{
    matches: PermissionMatcher;
  }>;
  /** Lazily load the platform adapter after registration and worker selection. */
  operations?: () => Promise<{
    createOperations(environment: NativeEnvironment): NativeAdapter;
  }>;
};

/** Replaced by the CLI with adapters from the app's direct plugin dependencies. */
export const packagedPlugins: readonly PackagedPlugin[] = [];
