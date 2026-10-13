import { readFileSync } from "node:fs";
import { monitorServices as nativeMonitors } from "#native/windows/bun/monitors";

export { windowMonitor } from "#native/windows/bun/monitors";

/** Real display enumeration with controlled metrics/failure, only in the WebView2 regression bundle. */
export const monitorServices = {
  ...nativeMonitors,
  list() {
    const path = process.env.BUNAWAY_MONITOR_CONTROL;
    if (!path) {
      throw new Error("Missing monitor fixture control file");
    }
    const mode = readFileSync(path, "utf8");
    if (mode === "fail") {
      throw new Error("Synthetic private enumeration failure");
    }
    return nativeMonitors
      .list()
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((monitor, index) =>
        index === 0
          ? {
              ...monitor,
              name: `Synthetic metrics ${mode}`,
            }
          : monitor,
      );
  },
};
