import type { NativeInvokeOptions, NativePluginAPI } from "@bunaway/plugin";
import type {
  AutostartOptions,
  AutostartStatus,
  autostartOperations,
} from "./contract.ts";

/** Build public helpers around the plugin's typed operations. */
export function createAutostart(
  api: NativePluginAPI<typeof autostartOperations>,
) {
  function enableAutostart(
    settings: string[] | AutostartOptions = [],
    options?: NativeInvokeOptions,
  ): Promise<AutostartStatus> {
    return api.enable(
      {
        ...(Array.isArray(settings)
          ? {
              args: settings,
            }
          : {
              args: [],
              ...settings,
            }),
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
