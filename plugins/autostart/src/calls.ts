import type { NativeInvokeOptions, NativePluginAPI } from "@bunaway/plugin";
import type { AutostartStatus, autostartOperations } from "./contract.ts";

/** Build public helpers around the plugin's typed operations. */
export function createAutostart(
  api: NativePluginAPI<typeof autostartOperations>,
) {
  function enableAutostart(
    args: string[] = [],
    options?: NativeInvokeOptions,
  ): Promise<AutostartStatus> {
    return api.enable(
      {
        args,
      },
      options,
    );
  }

  function disableAutostart(options?: NativeInvokeOptions): Promise<null> {
    return api.disable(null, options);
  }

  function getAutostartStatus(
    options?: NativeInvokeOptions,
  ): Promise<AutostartStatus> {
    return api.getStatus(null, options);
  }
  return {
    enableAutostart,
    disableAutostart,
    getAutostartStatus,
  };
}
