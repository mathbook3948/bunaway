import type { WindowChange, WindowSnapshot } from "@bunaway/plugin-api/native";

/** Compare committed snapshots in a fixed order, suppressing unchanged native messages. */
export function windowChanges(
  previous: WindowSnapshot,
  current: WindowSnapshot,
): WindowChange[] {
  const changes: WindowChange[] = [];
  const before = previous.state;
  const after = current.state;
  if (before.visible !== after.visible) {
    changes.push(after.visible ? "shown" : "hidden");
  }
  if (before.focused !== after.focused) {
    changes.push(after.focused ? "focus" : "blur");
  }
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
  if (before.fullscreen !== after.fullscreen) {
    changes.push(after.fullscreen ? "enterFullscreen" : "leaveFullscreen");
  }
  if (
    previous.bounds.x !== current.bounds.x ||
    previous.bounds.y !== current.bounds.y
  ) {
    changes.push("move");
  }
  if (
    previous.bounds.width !== current.bounds.width ||
    previous.bounds.height !== current.bounds.height ||
    previous.bounds.dpi !== current.bounds.dpi
  ) {
    changes.push("resize");
  }
  return changes;
}
