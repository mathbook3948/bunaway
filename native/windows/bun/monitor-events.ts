import { isDeepStrictEqual } from "node:util";
import type {
  NativeMonitor,
  NativeMonitorChange,
  NativeMonitorSnapshot,
} from "@bunaway/plugin-api/native";

const WM_DISPLAYCHANGE = 0x007e;
const WM_SETTINGCHANGE = 0x001a;
const WM_DEVICECHANGE = 0x0219;
const WM_DPICHANGED = 0x02e0;

/** Display topology, work area and per-window DPI messages request a fresh observation. */
export function isMonitorChangeMessage(message: number): boolean {
  return (
    message === WM_DISPLAYCHANGE ||
    message === WM_SETTINGCHANGE ||
    message === WM_DEVICECHANGE ||
    message === WM_DPICHANGED
  );
}

/** Track observed display changes without polling or replaying an initial event. */
export class MonitorTracker {
  private readonly sourceId = crypto.randomUUID();
  private current: NativeMonitorSnapshot | undefined;
  private dirty = true;

  constructor(
    private readonly read: () => NativeMonitor[],
    private readonly publish: (change: NativeMonitorChange) => void,
    private readonly report: (error: unknown) => void = () => {},
  ) {}

  /** Native callbacks only mark work; the UI loop coalesces a message batch. */
  invalidate(): void {
    this.dirty = true;
  }

  /** Recover current state even if an OS message or a subscription transition was missed. */
  snapshot(): NativeMonitorSnapshot {
    return structuredClone(this.refresh());
  }

  /** Read once after a dirty native message batch. No periodic queries are performed. */
  flush(): void {
    if (this.dirty) {
      this.refresh();
    }
  }

  private refresh(): NativeMonitorSnapshot {
    this.dirty = false;
    let monitors = this.current?.monitors ?? [];
    let error: NativeMonitorSnapshot["error"] = null;
    try {
      monitors = structuredClone(this.read()).sort((left, right) =>
        left.id.localeCompare(right.id),
      );
    } catch (cause) {
      this.report(cause);
      error = {
        code: "INTERNAL",
        message: "Display information is unavailable.",
      };
    }
    if (!this.current) {
      this.current = {
        sourceId: this.sourceId,
        revision: 0,
        monitors,
        error,
      };
      return this.current;
    }
    if (
      isDeepStrictEqual(this.current.monitors, monitors) &&
      isDeepStrictEqual(this.current.error, error)
    ) {
      return this.current;
    }
    const before = new Map(
      this.current.monitors.map((monitor) => [
        monitor.id,
        monitor,
      ]),
    );
    const after = new Map(
      monitors.map((monitor) => [
        monitor.id,
        monitor,
      ]),
    );
    const added = monitors
      .filter((monitor) => !before.has(monitor.id))
      .map((monitor) => monitor.id);
    const removed = this.current.monitors
      .filter((monitor) => !after.has(monitor.id))
      .map((monitor) => monitor.id);
    const changed = monitors
      .filter(
        (monitor) =>
          before.has(monitor.id) &&
          !isDeepStrictEqual(before.get(monitor.id), monitor),
      )
      .map((monitor) => monitor.id);
    this.current = {
      sourceId: this.sourceId,
      revision: this.current.revision + 1,
      monitors,
      error,
    };
    this.publish({
      sourceId: this.sourceId,
      revision: this.current.revision,
      added,
      removed,
      changed,
      error,
    });
    return this.current;
  }
}
