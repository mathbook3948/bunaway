import type {
  WindowBounds,
  WindowChange,
  WindowSnapshot,
} from "@bunaway/plugin-api/native";

/** Report net geometry changes when a native interactive move/resize loop finishes. */
export function completedGeometryChanges(
  before: WindowBounds,
  after: WindowBounds,
): WindowChange[] {
  const changes: WindowChange[] = [];
  if (before.x !== after.x || before.y !== after.y) {
    changes.push("moved");
  }
  if (
    before.width !== after.width ||
    before.height !== after.height ||
    before.dpi !== after.dpi
  ) {
    changes.push("resized");
  }
  return changes;
}

type WindowState = WindowSnapshot["state"];

/** Visibility and focus transitions, reported before any size-state change. */
function visibilityChanges(
  before: WindowState,
  after: WindowState,
): WindowChange[] {
  const changes: WindowChange[] = [];
  if (before.visible !== after.visible) {
    changes.push(after.visible ? "shown" : "hidden");
  }
  if (before.focused !== after.focused) {
    changes.push(after.focused ? "focus" : "blur");
  }
  return changes;
}

/** Maximize, minimize and restore transitions in the order the host reports them. */
function showStateChanges(
  before: WindowState,
  after: WindowState,
): WindowChange[] {
  const changes: WindowChange[] = [];
  if (before.maximized && !after.maximized) {
    changes.push("unmaximize");
  }
  if (!before.minimized && after.minimized) {
    changes.push("minimize");
  }
  if (!before.maximized && after.maximized) {
    changes.push("maximize");
  }
  if (
    (before.minimized && !after.minimized) ||
    (before.maximized && !after.maximized && !after.minimized)
  ) {
    changes.push("restore");
  }
  return changes;
}

/** Fullscreen and always-on-top transitions. */
function windowModeChanges(
  before: WindowState,
  after: WindowState,
): WindowChange[] {
  const changes: WindowChange[] = [];
  if (before.fullscreen !== after.fullscreen) {
    changes.push(after.fullscreen ? "enterFullscreen" : "leaveFullscreen");
  }
  if (before.alwaysOnTop !== after.alwaysOnTop) {
    changes.push(after.alwaysOnTop ? "enterAlwaysOnTop" : "leaveAlwaysOnTop");
  }
  return changes;
}

/** Position and size changes of the committed bounds. */
function boundsChanges(
  before: WindowBounds,
  after: WindowBounds,
): WindowChange[] {
  const changes: WindowChange[] = [];
  if (before.x !== after.x || before.y !== after.y) {
    changes.push("move");
  }
  if (
    before.width !== after.width ||
    before.height !== after.height ||
    before.dpi !== after.dpi
  ) {
    changes.push("resize");
  }
  return changes;
}

/** Compare committed snapshots in a fixed order, suppressing unchanged native messages. */
export function windowChanges(
  previous: WindowSnapshot,
  current: WindowSnapshot,
): WindowChange[] {
  return [
    ...visibilityChanges(previous.state, current.state),
    ...showStateChanges(previous.state, current.state),
    ...windowModeChanges(previous.state, current.state),
    ...boundsChanges(previous.bounds, current.bounds),
  ];
}
