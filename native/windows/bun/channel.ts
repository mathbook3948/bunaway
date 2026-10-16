// Shared Worker transport; Windows keeps its platform-specific boot configuration here.
import type { DesktopOptions } from "@bunaway/core";
import type {
  HostContext,
  NativeRegistration,
  Policy,
  RuntimeIdentity,
} from "@bunaway/protocol";
import type { WindowSpec } from "@bunaway/runtime-bun/window-config";

export * from "@bunaway/runtime-bun/worker-channel";
export type UIConfig = {
  /** Name, identifier and package versions that become `ctx.app`. */
  appMetadata: import("@bunaway/runtime-bun/app-metadata").AppMetadata;
  app?: import("@bunaway/plugin").NativeEnvironment["app"];
  runtime: RuntimeIdentity;
  policy: Policy;
  backendContext: HostContext;
  windows: WindowSpec[];
  assets: string;
  dataRoot: string;
  loader: string;
  icon?: string;
  legacyProfile?: boolean;
  plugins?: NativeRegistration[];
  desktop?: {
    /** Suppress only initial automatic display for a marked autostart invocation. */
    startHidden?: boolean;
    closeBehavior: NonNullable<DesktopOptions["closeBehavior"]>;
    tray?: {
      tooltip: string;
    };
  };
  devtools?: boolean;
};
