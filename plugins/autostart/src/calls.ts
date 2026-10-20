import type { NativeInvokeOptions, NativePluginAPI } from "@bunaway/plugin";
import type { AutostartOptions, AutostartStatus } from "#autostart/contract";
import type { autostartOperations } from "#autostart/operations";
/** Build public helpers around the plugin's typed operations. */
export function createAutostart(
  api: NativePluginAPI<typeof autostartOperations>,
) {
  /**
   * Replace this app's login registration (Windows Run value, macOS LaunchAgent plist) with the
   * host-selected launch and these app arguments. On macOS it takes effect at the next login.
   * Adds invocation metadata and optionally starts hidden when desktop.tray is configured.
   * Preserves Windows startup approval, including the user's disabled choice.
   * Rejects a Windows command line longer than 260 UTF-16 code units, and on macOS arguments
   * with control characters or a launch agent this app did not create.
   */
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

  /** Delete only this app's registration. Repeated removal succeeds; approval is not changed. */
  function disableAutostart(options?: NativeInvokeOptions): Promise<null> {
    return api.disable(null, options);
  }

  /** Read the real stored path and arguments without repairing or enabling the registration. */
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
