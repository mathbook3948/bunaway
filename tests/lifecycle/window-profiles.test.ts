import { dlopen, ptr } from "bun:ffi";
import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import {
  MAX_WINDOW_INSTANCES,
  type WindowSpec,
} from "@bunaway/plugin-api/native";
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
      unlock = lockProfileFile(path, file);
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

/** Run the collector in a fresh process, observing PID probes and optional probe failures. */
async function collectAtStartup(
  root: string,
  probeError?: "EPERM" | "EINVAL",
): Promise<{
  probes: number;
  events: string[];
}> {
  const modulePath = resolve(
    import.meta.dir,
    "../../native/windows/bun/window-profiles.ts",
  );
  const child = Bun.spawn(
    [
      process.execPath,
      "--eval",
      `import { spyOn } from "bun:test";
     import { WindowProfiles } from ${JSON.stringify(modulePath)};
     const kill = process.kill.bind(process);
     const probeError = ${JSON.stringify(probeError ?? null)};
     const probes = spyOn(process, "kill").mockImplementation((pid, signal) => {
       if (signal !== 0) throw new Error("Cleanup must only probe process existence.");
       if (probeError) throw Object.assign(new Error(probeError), {code: probeError});
       return kill(pid, signal);
     });
     const events = [];
     new WindowProfiles(${JSON.stringify(root)}, false, (event) => events.push(event)).collectOrphans();
     console.log(JSON.stringify({probes: probes.mock.calls.length, events}));`,
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
      timeout: 5_000,
    },
  );
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect({
    exit,
    stderr,
  }).toEqual({
    exit: 0,
    stderr: "",
  });
  return JSON.parse(stdout);
}

async function exitedOwnerPid(): Promise<number> {
  const child = Bun.spawn(
    [
      process.execPath,
      "--eval",
      "",
    ],
    {
      stdout: "ignore",
      stderr: "ignore",
      timeout: 5_000,
    },
  );
  expect(await child.exited).toBe(0);
  return child.pid;
}

function createProfile(
  temporaryRoot: string,
  pid: string | number,
  index: number,
): string {
  const path = resolve(
    temporaryRoot,
    `p${pid}-${index.toString(16).padStart(8, "0")}-0000-0000-0000-000000000000`,
  );
  mkdirSync(path, {
    recursive: true,
  });
  writeFileSync(resolve(path, "storage"), "preserve until owner exits");
  return path;
}

test("independent startups advance past an oversized foreign and live prefix with bounded probes and removals", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "bunaway-orphan-progress-"));
  const temporaryRoot = resolve(root, "webview", "temporary");
  const deadPid = await exitedOwnerPid();
  try {
    mkdirSync(temporaryRoot, {
      recursive: true,
    });
    const live: string[] = [];
    const dead: string[] = [];
    for (let index = 0; index < MAX_WINDOW_INSTANCES; index++) {
      mkdirSync(
        resolve(
          temporaryRoot,
          `a-foreign-${index.toString().padStart(3, "0")}`,
        ),
      );
      live.push(
        createProfile(
          temporaryRoot,
          process.pid.toString().padStart(12, "0"),
          index,
        ),
      );
      dead.push(createProfile(temporaryRoot, deadPid, index));
    }
    dead.push(createProfile(temporaryRoot, deadPid, MAX_WINDOW_INSTANCES));
    const remaining = () => dead.filter((path) => existsSync(path)).length;
    expect(await collectAtStartup(root)).toEqual({
      probes: 0,
      events: [],
    });
    expect(remaining()).toBe(MAX_WINDOW_INSTANCES + 1);
    expect(await collectAtStartup(root)).toEqual({
      probes: MAX_WINDOW_INSTANCES,
      events: [],
    });
    expect(remaining()).toBe(MAX_WINDOW_INSTANCES + 1);
    expect(await collectAtStartup(root)).toEqual({
      probes: MAX_WINDOW_INSTANCES,
      events: [],
    });
    // The probe and deletion budget stays bounded even when every candidate is dead.
    expect(remaining()).toBe(1);
    const early = createProfile(
      temporaryRoot,
      deadPid.toString().padStart(16, "0"),
      0,
    );
    expect(await collectAtStartup(root)).toEqual({
      probes: 1,
      events: [],
    });
    expect(remaining()).toBe(0);
    expect(existsSync(early)).toBe(true);
    expect((await collectAtStartup(root)).probes).toBeLessThanOrEqual(
      MAX_WINDOW_INSTANCES,
    );
    expect(existsSync(early)).toBe(false);
    for (const path of live) {
      expect(readFileSync(resolve(path, "storage"), "utf8")).toBe(
        "preserve until owner exits",
      );
    }
    expect(readdirSync(temporaryRoot)).toHaveLength(MAX_WINDOW_INSTANCES * 2);
  } finally {
    rmSync(root, {
      recursive: true,
      force: true,
    });
  }
});

test("a name checkpoint resumes after its anchor disappears and the listing changes", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "bunaway-orphan-listing-"));
  const temporaryRoot = resolve(root, "webview", "temporary");
  const deadPid = await exitedOwnerPid();
  try {
    mkdirSync(temporaryRoot, {
      recursive: true,
    });
    for (let index = 0; index < MAX_WINDOW_INSTANCES; index++) {
      mkdirSync(
        resolve(temporaryRoot, `a-${index.toString().padStart(3, "0")}`),
      );
    }
    const orphan = createProfile(temporaryRoot, deadPid, 0);
    expect((await collectAtStartup(root)).probes).toBe(0);
    // Remove the anchor and earlier entries, then insert entries on both sides.
    for (let index = 0; index < MAX_WINDOW_INSTANCES; index += 2) {
      rmSync(resolve(temporaryRoot, `a-${index.toString().padStart(3, "0")}`), {
        recursive: true,
      });
    }
    rmSync(
      resolve(
        temporaryRoot,
        `a-${(MAX_WINDOW_INSTANCES - 1).toString().padStart(3, "0")}`,
      ),
      {
        recursive: true,
      },
    );
    mkdirSync(resolve(temporaryRoot, "0-new-foreign"));
    const added = createProfile(temporaryRoot, deadPid, 1);
    expect((await collectAtStartup(root)).probes).toBe(2);
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(added)).toBe(false);
    expect(existsSync(resolve(temporaryRoot, "0-new-foreign"))).toBe(true);
  } finally {
    rmSync(root, {
      recursive: true,
      force: true,
    });
  }
});

test.skipIf(process.platform !== "win32" && process.getuid?.() === 0)(
  "locked orphans do not stop startup progress and remain collectible after unlocking",
  async () => {
    const root = mkdtempSync(resolve(tmpdir(), "bunaway-orphan-lock-"));
    const temporaryRoot = resolve(root, "webview", "temporary");
    const deadPid = await exitedOwnerPid();
    let unlock: (() => void) | undefined;
    try {
      mkdirSync(temporaryRoot, {
        recursive: true,
      });
      for (let index = 0; index < MAX_WINDOW_INSTANCES; index++) {
        mkdirSync(
          resolve(temporaryRoot, `a-${index.toString().padStart(3, "0")}`),
        );
      }
      const locked = createProfile(temporaryRoot, deadPid, 0);
      const later = createProfile(temporaryRoot, deadPid, 1);
      unlock = lockProfileFile(locked, resolve(locked, "storage"));
      expect((await collectAtStartup(root)).probes).toBe(0);
      expect(await collectAtStartup(root)).toEqual({
        probes: 2,
        events: [
          "profile-cleanup-retry",
        ],
      });
      expect(existsSync(locked)).toBe(true);
      expect(existsSync(later)).toBe(false);
      // A fresh owner retries the locked orphan after wrapping, without relying on memory.
      expect((await collectAtStartup(root)).events).toEqual([
        "profile-cleanup-retry",
      ]);
      expect(existsSync(locked)).toBe(true);
      unlock();
      unlock = undefined;
      expect((await collectAtStartup(root)).events).toEqual([]);
      expect(existsSync(locked)).toBe(false);
    } finally {
      unlock?.();
      rmSync(root, {
        recursive: true,
        force: true,
      });
    }
  },
);

test("invalid progress falls back safely and failed persistence reports loss of cross-startup progress", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "bunaway-orphan-cursor-"));
  const temporaryRoot = resolve(root, "webview", "temporary");
  const cursorPath = resolve(root, "webview", ".temporary-cleanup-cursor");
  const deadPid = await exitedOwnerPid();
  try {
    const live = createProfile(temporaryRoot, process.pid, 0);
    const invalidPids = [
      createProfile(temporaryRoot, 0, 0),
      createProfile(temporaryRoot, "999999999999999999999", 0),
    ];
    for (const cursor of [
      "broken JSON",
      "x".repeat(8_192),
      JSON.stringify({
        name: "untrusted",
      }),
      JSON.stringify("../../outside"),
    ]) {
      writeFileSync(cursorPath, cursor);
      const dead = createProfile(temporaryRoot, deadPid, 0);
      expect((await collectAtStartup(root)).probes).toBe(2);
      expect(existsSync(dead)).toBe(false);
      expect(existsSync(live)).toBe(true);
      for (const path of invalidPids) {
        expect(existsSync(path)).toBe(true);
      }
    }
    // A directory at the cursor destination makes atomic replacement fail on every OS.
    rmSync(cursorPath);
    mkdirSync(cursorPath);
    const dead = createProfile(temporaryRoot, deadPid, 0);
    expect((await collectAtStartup(root)).events).toEqual([
      "profile-cleanup-progress-failed",
    ]);
    expect(existsSync(dead)).toBe(false);
    expect(existsSync(live)).toBe(true);
    expect(readdirSync(resolve(root, "webview"))).toEqual([
      ".temporary-cleanup-cursor",
      "temporary",
    ]);
  } finally {
    rmSync(root, {
      recursive: true,
      force: true,
    });
  }
});

test.each([
  "EPERM",
  "EINVAL",
] as const)(
  "PID probe failure %s preserves storage until absence is confirmed",
  async (code) => {
    const root = mkdtempSync(resolve(tmpdir(), "bunaway-orphan-probe-"));
    const deadPid = await exitedOwnerPid();
    try {
      const orphan = createProfile(
        resolve(root, "webview", "temporary"),
        deadPid,
        0,
      );
      expect(await collectAtStartup(root, code)).toEqual({
        probes: 1,
        events: [],
      });
      expect(existsSync(orphan)).toBe(true);
      expect(await collectAtStartup(root)).toEqual({
        probes: 1,
        events: [],
      });
      expect(existsSync(orphan)).toBe(false);
    } finally {
      rmSync(root, {
        recursive: true,
        force: true,
      });
    }
  },
);

test("orphan links and cursor contents never authorize deletion outside temporary profiles", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "bunaway-orphan-links-"));
  const temporaryRoot = resolve(root, "webview", "temporary");
  const deadPid = await exitedOwnerPid();
  try {
    const outside = resolve(root, "outside");
    mkdirSync(outside);
    const storage = resolve(outside, "storage");
    writeFileSync(storage, "must survive");
    const orphanLink = createProfile(temporaryRoot, deadPid, 0);
    rmSync(orphanLink, {
      recursive: true,
    });
    symlinkSync(
      outside,
      orphanLink,
      process.platform === "win32" ? "junction" : "dir",
    );
    const cursorPath = resolve(root, "webview", ".temporary-cleanup-cursor");
    if (process.platform === "win32") {
      writeFileSync(cursorPath, JSON.stringify(outside));
    } else {
      // Atomic replacement must replace the cursor link, preserving its target.
      symlinkSync(storage, cursorPath);
    }
    expect(await collectAtStartup(root)).toEqual({
      probes: 1,
      events: [],
    });
    expect(existsSync(orphanLink)).toBe(false);
    expect(readFileSync(storage, "utf8")).toBe("must survive");
    expect(JSON.parse(readFileSync(cursorPath, "utf8"))).toBe(
      basename(orphanLink),
    );
  } finally {
    rmSync(root, {
      recursive: true,
      force: true,
    });
  }
});

function lockProfileFile(profilePath: string, file: string): () => void {
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
    return () => {
      assert(kernel.symbols.CloseHandle(handle));
      kernel.close();
    };
  } else {
    chmodSync(profilePath, 0o500);
    return () => chmodSync(profilePath, 0o700);
  }
}
