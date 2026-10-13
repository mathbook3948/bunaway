import type { NativeMonitor } from "@bunaway/plugin-api/native";

/** Deterministic physical monitor data for display transition and wire-contract tests. */
export function fixtureMonitor(id = "\\\\.\\DISPLAY1"): NativeMonitor {
  return {
    id,
    name: `Monitor ${id}`,
    primary: true,
    bounds: {
      x: -1920,
      y: 0,
      width: 1920,
      height: 1080,
    },
    workArea: {
      x: -1920,
      y: 0,
      width: 1920,
      height: 1040,
    },
    dpi: 144,
    scaleFactor: 1.5,
    rotation: 0,
    refreshRate: 60,
  };
}
