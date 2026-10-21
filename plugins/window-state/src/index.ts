import { defineNativePlugin } from "@bunaway/plugin";
import store from "@bunaway/plugin-store";
import windows from "@bunaway/plugin-windows";
import { createWindowState } from "#window-state/state";

/**
 * Save and restore window position, size, maximized, fullscreen and visible state.
 * It declares no native operations of its own: every call goes through the window and store
 * plugins and runs under the caller's permissions for those operations.
 */
export default defineNativePlugin(
  {
    name: "windowState",
    platforms: {},
  },
  () =>
    createWindowState({
      windows,
      store,
    }),
);

export type {
  WindowStateInclude,
  WindowStateRemoveInput,
  WindowStateRestoreInput,
  WindowStateRestoreResult,
  WindowStateSaveInput,
} from "#window-state/contract";
