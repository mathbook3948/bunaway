import { expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { WindowSpec } from "@bunaway/plugin-api/native";
import { WindowProfiles } from "#native/windows/bun/window-profiles";

const spec: WindowSpec = {
  view: "Editor:A",
  title: "Editor",
  home: "https://app.bunaway.local",
  window: {
    width: 800,
    height: 600,
  },
};
test("profiles share persistent view storage and keep isolated storage only through the same logical recreation", () => {
  const root = mkdtempSync(resolve(tmpdir(), "bunaway-window-profiles-"));
  try {
    const profiles = new WindowProfiles(root, false, () => {});
    expect(profiles.path(spec, "one")).toBe(profiles.path(spec, "two"));
    expect(profiles.path(spec, "one")).not.toBe(
      profiles.path(
        {
          ...spec,
          view: "editor:a",
        },
        "three",
      ),
    );
    const isolated = {
      ...spec,
      profile: "isolated" as const,
    };
    const first = profiles.path(isolated, "one");
    const second = profiles.path(isolated, "two");
    expect(first).not.toBe(second);
    writeFileSync(resolve(first, "storage"), "private");
    expect(profiles.release("one", true)).toBe(true);
    expect(profiles.path(isolated, "one")).toBe(first);
    expect(readFileSync(resolve(first, "storage"), "utf8")).toBe("private");
    const restarted = new WindowProfiles(root, false, () => {});
    const afterRestart = restarted.path(isolated, "one");
    expect(afterRestart).not.toBe(first);
    expect(existsSync(resolve(afterRestart, "storage"))).toBe(false);
    expect(profiles.release("one", false)).toBe(true);
    expect(existsSync(first)).toBe(false);
    expect(existsSync(second)).toBe(true);
    expect(profiles.path(isolated, "one")).not.toBe(first);
    expect(new WindowProfiles(root, true, () => {}).path(spec, "legacy")).toBe(
      resolve(root, "webview"),
    );
    // Startup collection must leave profiles belonging to a live process untouched.
    restarted.collectOrphans();
    expect(existsSync(second)).toBe(true);
  } finally {
    rmSync(root, {
      recursive: true,
      force: true,
    });
  }
});
