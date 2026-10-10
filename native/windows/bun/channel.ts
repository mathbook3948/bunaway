// Shared Worker transport; Windows keeps its platform-specific boot configuration here.
import type {
  HostContext,
  NativeRegistration,
  Policy,
  RuntimeIdentity,
} from "../../../packages/protocol/src/index.ts";
import type { WindowSpec } from "../../../packages/runtime-bun/src/window-config.ts";
export * from "../../../packages/runtime-bun/src/worker-channel.ts";
export type UIConfig = {
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
    closeBehavior: "quit" | "hide";
    tray?: {
      tooltip: string;
    };
  };
  devtools?: boolean;
};
