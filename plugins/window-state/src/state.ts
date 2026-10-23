import type store from "@bunaway/plugin-store";
import type windows from "@bunaway/plugin-windows";
import {
  LOGICAL_DPI,
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
import {
  fitToMonitors,
  type Rect,
  type WindowFrame,
} from "#window-state/placement";

/** The window and store operations this plugin consumes. */
export type WindowStateDependencies = {
  windows: Pick<
    typeof windows,
    | "getContentBounds"
    | "getMonitors"
    | "getNormalBounds"
    | "getOuterBounds"
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
type DisplayState = Awaited<ReturnType<WindowsClient["getSnapshot"]>>["state"];

/** Logical pixels added to the size limits of a minimized window, whose frame cannot be read. */
const MINIMIZED_FRAME_LOGICAL_PIXELS = 64;

const DEFAULT_INCLUDE = {
  position: true,
  size: true,
  maximized: true,
  fullscreen: true,
  visible: false,
} satisfies Required<WindowStateInclude>;

/**
 * Move and resize to the saved rectangle fitted to the current monitors. A field left out of
 * `include` keeps the window's current value.
 */
async function applyBounds(
  windows: WindowsClient,
  saved: SavedWindowState,
  include: Required<WindowStateInclude>,
  minimized: boolean,
): Promise<boolean> {
  const current =
    include.position && include.size
      ? saved
      : await windows.getNormalBounds({
          unit: "physical",
        });
  const requested = {
    x: include.position ? saved.x : current.x,
    y: include.position ? saved.y : current.y,
    width: include.size ? saved.width : current.width,
    height: include.size ? saved.height : current.height,
    // The size is converted by the ratio of DPI values, so it must name the DPI it was read at.
    dpi: include.size ? saved.dpi : current.dpi,
  };
  const monitors = await windows.getMonitors();
  const fit = async () =>
    fitToMonitors(requested, monitors, await measureFrame(windows, minimized));
  const fitted = await fit();
  await place(windows, fitted.bounds);
  // A window that crosses to a monitor with another DPI is resized by the OS when the DPI
  // change arrives, after the call returned. Once it sits on the target monitor, fit it again
  // with the frame and size limits of the new DPI and place it a second time.
  const { dpi: _dpi, ...placed } = await windows.getNormalBounds({
    unit: "physical",
  });
  if (sameRect(placed, fitted.bounds)) {
    return fitted.adjusted;
  }
  const refitted = await fit();
  await place(windows, refitted.bounds);
  return refitted.adjusted;
}

function place(windows: WindowsClient, bounds: Rect) {
  return windows.setOuterBounds({
    unit: "physical",
    ...bounds,
  });
}

/**
 * The window size limits apply to the content area at the window's current DPI, so measure how
 * much larger the outer rectangle is than the content. A minimized window reports the size of
 * its icon, so its frame cannot be measured and a generous allowance stands in for it. The
 * allowance raises the minimum, so a size the native check would reject is not sent, and a
 * small saved size grows to the raised minimum. It is not added to the maximum.
 */
async function measureFrame(
  windows: WindowsClient,
  minimized: boolean,
): Promise<WindowFrame> {
  if (minimized) {
    const { dpi } = await windows.getNormalBounds({
      unit: "physical",
    });
    const allowance = Math.ceil(
      (MINIMIZED_FRAME_LOGICAL_PIXELS * dpi) / LOGICAL_DPI,
    );
    return {
      width: allowance,
      height: allowance,
      dpi,
      estimated: true,
    };
  }
  const outer = await windows.getOuterBounds({
    unit: "physical",
  });
  const content = await windows.getContentBounds({
    unit: "physical",
  });
  return {
    width: outer.width - content.width,
    height: outer.height - content.height,
    dpi: outer.dpi,
  };
}

function sameRect(a: Rect, b: Rect): boolean {
  return (
    a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
  );
}

/** Returns whether a window operation ran, because maximizing or restoring can show a hidden window. */
async function applyMaximized(
  windows: WindowsClient,
  saved: SavedWindowState,
  current: DisplayState,
): Promise<boolean> {
  if (saved.maximized === current.maximized) {
    return false;
  }
  await (saved.maximized ? windows.maximize() : windows.unmaximize());
  return true;
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
    async save(input: WindowStateSaveInput = {}): Promise<null> {
      const parsed = saveInputSchema.parse(input);
      const snapshot = await windows.getSnapshot();
      const normal = await windows.getNormalBounds({
        unit: "physical",
      });
      // A window minimized from maximized may report not maximized, so a minimized window also
      // keeps what an earlier save recorded.
      const earlier = snapshot.state.minimized
        ? await read(parsed.key ?? snapshot.viewId)
        : null;
      const state: SavedWindowState = {
        version: 1,
        x: normal.x,
        y: normal.y,
        width: normal.width,
        height: normal.height,
        dpi: normal.dpi,
        maximized: snapshot.state.maximized || (earlier?.maximized ?? false),
        fullscreen: snapshot.state.fullscreen,
        visible: snapshot.state.visible,
      };
      await open();
      await store.set({
        name: WINDOW_STATE_STORE,
        key: parsed.key ?? snapshot.viewId,
        value: state,
      });
      await store.save({
        name: WINDOW_STATE_STORE,
      });
      return null;
    },

    /** Apply the saved state, leaving the window alone when nothing valid is saved. */
    async restore(
      input: WindowStateRestoreInput = {},
    ): Promise<WindowStateRestoreResult> {
      const parsed = restoreInputSchema.parse(input);
      // The default key is the app's view ID, which the open window's snapshot names.
      const { viewId, state } = await windows.getSnapshot();
      const saved = await read(parsed.key ?? viewId);
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
          fullscreen: false,
        });
      }
      const adjusted =
        (include.position || include.size) &&
        (await applyBounds(windows, saved, include, state.minimized));
      const changedShowState =
        include.maximized && (await applyMaximized(windows, saved, state));
      if (wantFullscreen && (leavesFullscreen || !state.fullscreen)) {
        await windows.setFullscreen({
          fullscreen: true,
        });
      }
      if (include.visible) {
        await (saved.visible ? windows.show() : windows.hide());
      } else if (changedShowState && !state.visible) {
        // Maximizing or restoring shows a hidden window; keep it hidden as it was.
        await windows.hide();
      }
      return {
        restored: true,
        adjusted,
      };
    },

    /** Delete the saved state of a key; without one, the open window's view ID. */
    async remove(input: WindowStateRemoveInput = {}): Promise<{
      removed: boolean;
    }> {
      const parsed = removeInputSchema.parse(input);
      const key = parsed.key ?? (await windows.getSnapshot()).viewId;
      await open();
      const { changed } = await store.delete({
        name: WINDOW_STATE_STORE,
        key,
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
