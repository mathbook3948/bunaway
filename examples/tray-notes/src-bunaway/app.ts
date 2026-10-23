import { defineApp } from "@bunaway/backend";
import storage from "@bunaway/plugin-storage";
import store from "@bunaway/plugin-store";
import tray from "@bunaway/plugin-tray";
import windowState from "@bunaway/plugin-window-state";
import windows from "@bunaway/plugin-windows";
import { notes } from "./notes/module.ts";

/**
 * A tray-resident note with one window. `keep-alive` closes the window for real and keeps the
 * backend running; the tray Open item creates a new window, which is always shown.
 */
export const notesApp = defineApp({
  plugins: [
    storage,
    store,
    tray,
    windows,
    windowState,
  ],
  modules: [
    notes,
  ],
  desktop: {
    closeBehavior: "keep-alive",
    tray: {
      tooltip: "bunaway tray notes",
    },
  },
});

export default notesApp;
