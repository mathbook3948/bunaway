import type store from "@bunaway/plugin-store";
import type windows from "@bunaway/plugin-windows";
import {
  removeInputSchema,
  restoreInputSchema,
  type SavedWindowState,
  savedWindowStateSchema,
  saveInputSchema,
  WINDOW_STATE_STORE,
  type WindowStateInclude,
  type WindowStateRemoveInput,
  type WindowStateRestoreInput,
  type WindowStateRestoreResult,
  type WindowStateSaveInput,
} from "#window-state/contract";
import { fitToMonitors, type Rect } from "#window-state/placement";

/** The window and store operations this plugin consumes. */
export type WindowStateDependencies = {
  windows: Pick<
    typeof windows,
    | "getMonitors"
    | "getNormalBounds"
    | "getSnapshot"
    | "hide"
    | "maximize"
    | "setFullscreen"
    | "setOuterBounds"
    | "show"
    | "unmaximize"
  >;
  store: Pick<typeof store, "delete" | "get" | "load" | "save" | "set">;
};
type WindowsClient = WindowStateDependencies["windows"];
type WindowTarget = {
  view: string;
  windowId?: string;
};
type DisplayState = Awaited<ReturnType<WindowsClient["getSnapshot"]>>["state"];

const DEFAULT_INCLUDE = {
  position: true,
  size: true,
  maximized: true,
  fullscreen: true,
  visible: false,
} satisfies Required<WindowStateInclude>;

function windowTarget(input: {
  view: string;
  windowId?: string | undefined;
}): WindowTarget {
  return input.windowId === undefined
    ? {
        view: input.view,
      }
    : {
        view: input.view,
        windowId: input.windowId,
      };
}

/**
 * Move and resize to the saved rectangle fitted to the current monitors. A field left out of
 * `include` keeps the window's current value.
 */
async function applyBounds(
  windows: WindowsClient,
  window: WindowTarget,
  saved: SavedWindowState,
  include: Required<WindowStateInclude>,
): Promise<boolean> {
  const current =
    include.position && include.size
      ? saved
      : await windows.getNormalBounds({
          ...window,
          unit: "physical",
        });
  const fitted = fitToMonitors(
    {
      x: include.position ? saved.x : current.x,
      y: include.position ? saved.y : current.y,
      width: include.size ? saved.width : current.width,
      height: include.size ? saved.height : current.height,
      // The size is converted by the ratio of DPI values, so it must name the DPI it was read at.
      dpi: include.size ? saved.dpi : current.dpi,
    },
    await windows.getMonitors(),
  );
  const place = () =>
    windows.setOuterBounds({
      ...window,
      unit: "physical",
      ...fitted.bounds,
    });
  await place();
  // A window that crosses to a monitor with another DPI is resized by the OS when the DPI
  // change arrives, after the call returned. Once it sits on the target monitor, place it again.
  const { dpi: _dpi, ...placed } = await windows.getNormalBounds({
    ...window,
    unit: "physical",
  });
  if (!sameRect(placed, fitted.bounds)) {
    await place();
  }
  return fitted.adjusted;
}

function sameRect(a: Rect, b: Rect): boolean {
  return (
    a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
  );
}

/** Returns whether a window operation ran, because maximizing or restoring can show a hidden window. */
async function applyMaximized(
  windows: WindowsClient,
  window: WindowTarget,
  saved: SavedWindowState,
  current: DisplayState,
): Promise<boolean> {
  if (saved.maximized) {
    await windows.maximize(window);
    return true;
  }
  if (current.maximized) {
    await windows.unmaximize(window);
    return true;
  }
  return false;
}

/** Save, restore and remove window states using the window and store operations. */
export function createWindowState({ windows, store }: WindowStateDependencies) {
  /** Reopening with the same options is a no-op, so every call can make sure the store is open. */
  const open = () =>
    store.load({
      name: WINDOW_STATE_STORE,
      autosave: false,
      onInvalidFile: "reset",
    });

  /** A missing key and a record that fails validation both read as nothing saved. */
  async function read(key: string): Promise<SavedWindowState | null> {
    await open();
    const { found, value } = await store.get({
      name: WINDOW_STATE_STORE,
      key,
    });
    if (!found) {
      return null;
    }
    const parsed = savedWindowStateSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  }

  return {
    /** Store the window's normal bounds, DPI, maximized, fullscreen and visible state. */
    async save(input: WindowStateSaveInput): Promise<null> {
      const parsed = saveInputSchema.parse(input);
      const window = windowTarget(parsed);
      const snapshot = await windows.getSnapshot(window);
      const normal = await windows.getNormalBounds({
        ...window,
        unit: "physical",
      });
      // A minimized window reports not maximized, so keep what an earlier save recorded.
      const earlier = snapshot.state.minimized
        ? await read(parsed.key ?? parsed.view)
        : null;
      const state: SavedWindowState = {
        version: 1,
        x: normal.x,
        y: normal.y,
        width: normal.width,
        height: normal.height,
        dpi: normal.dpi,
        maximized: snapshot.state.minimized
          ? (earlier?.maximized ?? false)
          : snapshot.state.maximized,
        fullscreen: snapshot.state.fullscreen,
        visible: snapshot.state.visible,
      };
      await open();
      await store.set({
        name: WINDOW_STATE_STORE,
        key: parsed.key ?? parsed.view,
        value: state,
      });
      await store.save({
        name: WINDOW_STATE_STORE,
      });
      return null;
    },

    /** Apply the saved state, leaving the window alone when nothing valid is saved. */
    async restore(
      input: WindowStateRestoreInput,
    ): Promise<WindowStateRestoreResult> {
      const parsed = restoreInputSchema.parse(input);
      const saved = await read(parsed.key ?? parsed.view);
      if (!saved) {
        return {
          restored: false,
          adjusted: false,
        };
      }
      const include = {
        ...DEFAULT_INCLUDE,
        ...parsed.include,
      };
      const window = windowTarget(parsed);
      const { state } = await windows.getSnapshot(window);
      const wantFullscreen = include.fullscreen
        ? saved.fullscreen
        : state.fullscreen;
      // Geometry changes are refused in fullscreen: leave it first and re-enter at the end.
      const leavesFullscreen =
        state.fullscreen &&
        (include.position ||
          include.size ||
          include.maximized ||
          !wantFullscreen);
      if (leavesFullscreen) {
        await windows.setFullscreen({
          ...window,
          fullscreen: false,
        });
      }
      const adjusted =
        (include.position || include.size) &&
        (await applyBounds(windows, window, saved, include));
      let changedShowState =
        include.maximized &&
        (await applyMaximized(windows, window, saved, state));
      if (wantFullscreen && (leavesFullscreen || !state.fullscreen)) {
        await windows.setFullscreen({
          ...window,
          fullscreen: true,
        });
        changedShowState = true;
      }
      if (include.visible) {
        await (saved.visible ? windows.show(window) : windows.hide(window));
      } else if (changedShowState && !state.visible) {
        // Maximizing or entering fullscreen shows a hidden window; keep it hidden as it was.
        await windows.hide(window);
      }
      return {
        restored: true,
        adjusted,
      };
    },

    /** Delete the saved state of a window name or key. */
    async remove(input: WindowStateRemoveInput): Promise<{
      removed: boolean;
    }> {
      const parsed = removeInputSchema.parse(input);
      await open();
      const { changed } = await store.delete({
        name: WINDOW_STATE_STORE,
        key: parsed.key ?? parsed.view ?? "",
      });
      await store.save({
        name: WINDOW_STATE_STORE,
      });
      return {
        removed: changed,
      };
    },
  };
}
