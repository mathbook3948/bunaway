import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { appModules } from "#cli/app-modules";
import { frameworkPaths } from "#cli/distribution";

/** Inspect the actual host bundles, with no optional plugin package selected. No native APIs run. */
test.each([
  "windows",
  "macos",
] as const)(
  "minimal %s host omits optional tray, menu and ICO implementations",
  async (platform) => {
    const loaded: string[] = [];
    const result = await Bun.build({
      entrypoints: [
        resolve(
          import.meta.dir,
          `../../native/${platform}/bun/${platform === "windows" ? "ui" : "entry"}.ts`,
        ),
      ],
      target: "bun",
      plugins: [
        {
          name: "observe-optional-module-boundary",
          setup(build) {
            build.onLoad(
              {
                filter: /[\\/]plugins[\\/](tray|menu)[\\/]/,
              },
              ({ path }) => {
                loaded.push(path);
              },
            );
          },
        },
        appModules({
          plugins: [],
          platform,
        }),
      ],
    });
    expect(result.success, result.logs.map(String).join("\n")).toBe(true);
    expect(loaded).toEqual([]);
    const bundle = await result.outputs[0]?.text();
    expect(bundle).toBeDefined();
    for (const implementation of [
      "Shell_NotifyIconW",
      "Shell_NotifyIconGetRect",
      "TrackPopupMenuEx",
      "CreatePopupMenu",
      "CreateIconFromResourceEx",
      "trayIconImage",
    ]) {
      expect(bundle).not.toContain(implementation);
    }
    expect(
      frameworkPaths.some((path) =>
        /native\/windows\/bun\/(tray|tray-icon|tray-icon-data|menu)\.ts$/.test(
          path,
        ),
      ),
    ).toBe(false);
  },
);
