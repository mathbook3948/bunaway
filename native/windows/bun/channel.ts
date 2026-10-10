// Shared Worker transport; Windows keeps its platform-specific boot configuration here.
import type {
  HostContext,
  NativeRegistration,
  Policy,
  RuntimeIdentity,
} from "@bunaway/protocol";
import type { WindowSpec } from "@bunaway/runtime-bun/window-config";
export * from "@bunaway/runtime-bun/worker-channel";
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
