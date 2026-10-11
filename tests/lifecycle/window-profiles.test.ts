import { dlopen, ptr } from "bun:ffi";
import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import {
  chmodSync,
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
const GENERIC_READ = 0x80000000;
const OPEN_EXISTING = 3;
const FILE_ATTRIBUTE_NORMAL = 0x80;
const INVALID_HANDLE_VALUE = 0xffffffffffffffffn;
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

test.skipIf(process.platform !== "win32" && process.getuid?.() === 0)(
  "failed profile deletion keeps ownership after its diagnostic deadline and succeeds after unlocking",
  async () => {
    const root = mkdtempSync(resolve(tmpdir(), "bunaway-locked-profile-"));
    const logs: string[] = [];
    const profiles = new WindowProfiles(root, false, (event) =>
      logs.push(event),
    );
    const isolated = {
      ...spec,
      profile: "isolated" as const,
    };
    const path = profiles.path(isolated, "owner");
    const file = resolve(path, "storage");
    writeFileSync(file, "private");
    let unlock: (() => void) | undefined;
    try {
      if (process.platform === "win32") {
        const kernel = dlopen("kernel32.dll", {
          CreateFileW: {
            args: [
              "ptr",
              "u32",
              "u32",
              "ptr",
              "u32",
              "u32",
              "u64",
            ],
            returns: "u64",
          },
          CloseHandle: {
            args: [
              "u64",
            ],
            returns: "i32",
          },
        });
        const filename = Buffer.from(`${file}\0`, "utf16le");
        // An existing file handle without FILE_SHARE_DELETE blocks actual Windows removal.
        const handle = kernel.symbols.CreateFileW(
          ptr(filename),
          GENERIC_READ,
          0,
          null,
          OPEN_EXISTING,
          FILE_ATTRIBUTE_NORMAL,
          0n,
        );
        if (handle === INVALID_HANDLE_VALUE) {
          kernel.close();
          throw new Error("Could not lock the temporary profile file.");
        }
        unlock = () => {
          assert(kernel.symbols.CloseHandle(handle));
          kernel.close();
        };
      } else {
        chmodSync(path, 0o500);
        unlock = () => chmodSync(path, 0o700);
      }
      expect(profiles.release("owner", false)).toBe(false);
      await Bun.sleep(3_100);
      expect(profiles.release("owner", false)).toBe(false);
      expect(existsSync(path)).toBe(true);
      expect(profiles.path(isolated, "owner")).toBe(path);
      expect(logs).toEqual([
        "profile-cleanup-retry",
        "profile-cleanup-deferred",
      ]);
      await Bun.sleep(110);
      expect(profiles.release("owner", false)).toBe(false);
      expect(logs).toHaveLength(2);
      unlock();
      unlock = undefined;
      await Bun.sleep(110);
      expect(profiles.release("owner", false)).toBe(true);
      expect(existsSync(path)).toBe(false);
      expect(profiles.path(isolated, "owner")).not.toBe(path);
    } finally {
      unlock?.();
      rmSync(root, {
        recursive: true,
        force: true,
      });
    }
  },
  10_000,
);
