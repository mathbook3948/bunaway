import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import crashReport from "@bunaway/plugin-crash-report";
import { BunawayError, NativeRegistry } from "@bunaway/protocol";
import {
  crashDumpListSchema,
  MAX_CRASH_DUMP_TOTAL_BYTES,
  MAX_CRASH_DUMPS,
  removeInputSchema,
} from "#plugins/crash-report/src/contract";
import { crashReportOperations } from "#plugins/crash-report/src/operations";
import { scanDumps } from "#plugins/crash-report/src/platforms/dump-folder";
import { relativeDumpFolder } from "#plugins/crash-report/src/platforms/windows";
import {
  type WerBindings,
  WindowsCrashReport,
} from "#plugins/crash-report/src/platforms/windows-crash-report";

const FLAGS_OFFSET = 24;
const FULL_MEMORY = 0x2;
const E_INVALIDARG = 0x80070057 | 0;

/** A minidump header (signature, flags at byte 24) followed by padding up to `size` bytes. */
function dumpBytes(flags: number, size = 64): Buffer {
  const bytes = Buffer.alloc(size);
  bytes.write("MDMP", 0, "latin1");
  bytes.writeBigUInt64LE(BigInt(flags), FLAGS_OFFSET);
  return bytes;
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "bunaway-crash-report-"));
  const folder = join(root, "crash-dumps");
  const calls: string[] = [];
  const results = {
    register: 0,
    unregister: 0,
  };
  const bindings: WerBindings = {
    register(relative) {
      calls.push(`register:${relative}`);
      return results.register;
    },
    unregister() {
      calls.push("unregister");
      return results.unregister;
    },
  };
  let released = 0;
  const adapter = new WindowsCrashReport(
    bindings,
    folder,
    "app\\crash-dumps",
    () => {
      released += 1;
    },
  );
  const write = (name: string, bytes: Buffer, ageSeconds = 0) => {
    mkdirSync(folder, {
      recursive: true,
    });
    const path = join(folder, name);
    writeFileSync(path, bytes);
    const when = new Date(Date.now() - ageSeconds * 1000);
    utimesSync(path, when, when);
  };
  return {
    root,
    folder,
    calls,
    results,
    adapter,
    write,
    released: () => released,
    cleanup: () =>
      rmSync(root, {
        recursive: true,
        force: true,
      }),
  };
}

test("enable creates the folder, registers it once and survives a second call", () => {
  const world = setup();
  try {
    world.adapter.enable();
    world.adapter.enable();
    expect(world.calls).toEqual([
      "register:app\\crash-dumps",
    ]);
    expect(scanDumps(world.folder)).toEqual([]);
  } finally {
    world.cleanup();
  }
});

test("a failed registration reports the HRESULT and can be retried", () => {
  const world = setup();
  try {
    world.results.register = E_INVALIDARG;
    expect(() => world.adapter.enable()).toThrow(/0x80070057/);
    world.results.register = 0;
    world.adapter.enable();
    expect(world.calls.length).toBe(2);
  } finally {
    world.cleanup();
  }
});

test("disable unregisters only a registration and keeps the dumps", () => {
  const world = setup();
  try {
    world.adapter.disable();
    expect(world.calls).toEqual([]);
    world.adapter.enable();
    world.write("app.exe.1.dmp", dumpBytes(0));
    world.adapter.disable();
    expect(world.calls).toEqual([
      "register:app\\crash-dumps",
      "unregister",
    ]);
    expect(world.adapter.list().length).toBe(1);
    world.adapter.enable();
    expect(world.calls.length).toBe(3);
  } finally {
    world.cleanup();
  }
});

test("list reports metadata only, newest first, and tells dump kinds apart", () => {
  const world = setup();
  try {
    world.write("old.dmp", dumpBytes(0, 100), 60);
    world.write("new.DMP", dumpBytes(FULL_MEMORY, 200), 10);
    world.write("junk.dmp", Buffer.from("not a dump"), 30);
    world.write("notes.txt", dumpBytes(0), 5);
    const list = world.adapter.list();
    expect(crashDumpListSchema.parse(list)).toEqual(list);
    expect(
      list.map((dump) => [
        dump.kind,
        dump.sizeBytes,
      ]),
    ).toEqual([
      [
        "full",
        200,
      ],
      [
        "unknown",
        10,
      ],
      [
        "mini",
        100,
      ],
    ]);
    for (const dump of list) {
      expect(Object.keys(dump).sort()).toEqual([
        "createdAtMs",
        "id",
        "kind",
        "sizeBytes",
      ]);
      expect(JSON.stringify(dump).toLowerCase()).not.toContain("dmp");
    }
    expect(list[0]?.createdAtMs).toBeGreaterThan(list[2]?.createdAtMs ?? 0);
  } finally {
    world.cleanup();
  }
});

test("a missing folder lists nothing", () => {
  const world = setup();
  try {
    expect(world.adapter.list()).toEqual([]);
  } finally {
    world.cleanup();
  }
});

test("links and directories named like dumps are not listed", () => {
  const world = setup();
  try {
    world.write("real.dmp", dumpBytes(0));
    mkdirSync(join(world.folder, "directory.dmp"));
    const target = join(world.root, "outside.dmp");
    writeFileSync(target, dumpBytes(0));
    try {
      symlinkSync(target, join(world.folder, "link.dmp"));
    } catch (error) {
      // Creating a symbolic link needs a privilege some runners lack.
      expect((error as NodeJS.ErrnoException).code).toBe("EPERM");
    }
    expect(scanDumps(world.folder).map((entry) => entry.name)).toEqual([
      "real.dmp",
    ]);
  } finally {
    world.cleanup();
  }
});

test("remove deletes by id only and reports an unknown id", () => {
  const world = setup();
  try {
    world.write("a.dmp", dumpBytes(0), 20);
    world.write("b.dmp", dumpBytes(0), 10);
    const [newest, oldest] = world.adapter.list();
    expect(
      world.adapter.remove({
        id: "0".repeat(32),
      }),
    ).toEqual({
      removed: false,
    });
    expect(
      world.adapter.remove({
        id: newest?.id ?? "",
      }),
    ).toEqual({
      removed: true,
    });
    expect(world.adapter.list()).toEqual([
      oldest,
    ]);
    expect(
      removeInputSchema.safeParse({
        id: "..\\..\\secret.dmp",
      }).success,
    ).toBe(false);
    expect(
      removeInputSchema.safeParse({
        id: "a".repeat(32),
        path: "x",
      }).success,
    ).toBe(false);
  } finally {
    world.cleanup();
  }
});

test("enable and list keep at most the newest dumps", () => {
  const world = setup();
  try {
    for (let index = 0; index < MAX_CRASH_DUMPS + 3; index += 1) {
      world.write(`dump-${index}.dmp`, dumpBytes(0), 1000 - index);
    }
    world.adapter.enable();
    const names = scanDumps(world.folder).map((entry) => entry.name);
    expect(names.length).toBe(MAX_CRASH_DUMPS);
    expect(names).not.toContain("dump-0.dmp");
    expect(names).toContain(`dump-${MAX_CRASH_DUMPS + 2}.dmp`);
    expect(world.adapter.list().length).toBe(MAX_CRASH_DUMPS);
  } finally {
    world.cleanup();
  }
});

test("the byte limit drops the oldest dumps but never the newest", () => {
  const world = setup();
  try {
    const big = MAX_CRASH_DUMP_TOTAL_BYTES / 2 + 1;
    world.write("oldest.dmp", dumpBytes(0, 64), 30);
    world.write("older.dmp", dumpBytes(0, big), 20);
    world.write("newest.dmp", dumpBytes(0, big), 10);
    expect(world.adapter.list().map((dump) => dump.sizeBytes)).toEqual([
      big,
    ]);
    expect(scanDumps(world.folder).map((entry) => entry.name)).toEqual([
      "newest.dmp",
    ]);
  } finally {
    world.cleanup();
  }
});

test("a disposed adapter refuses every operation and keeps the registration", () => {
  const world = setup();
  try {
    world.adapter.enable();
    world.adapter.dispose();
    world.adapter.dispose();
    expect(world.released()).toBe(1);
    expect(world.calls).toEqual([
      "register:app\\crash-dumps",
    ]);
    for (const call of [
      () => world.adapter.enable(),
      () => world.adapter.disable(),
      () => world.adapter.list(),
      () =>
        world.adapter.remove({
          id: "0".repeat(32),
        }),
    ]) {
      expect(call).toThrow(BunawayError);
    }
  } finally {
    world.cleanup();
  }
});

test("the dump folder must lie inside local app data", () => {
  const local = "C:\\Users\\me\\AppData\\Local";
  expect(relativeDumpFolder(`${local}\\bunaway\\app\\crash-dumps`, local)).toBe(
    "bunaway\\app\\crash-dumps",
  );
  for (const folder of [
    "D:\\Data\\app\\crash-dumps",
    "C:\\Users\\me\\AppData\\LocalLow\\x",
    local,
  ]) {
    expect(() => relativeDumpFolder(folder, local)).toThrow(/local app data/);
  }
});

test("each operation has its own permission", () => {
  const registry = new NativeRegistry([
    crashReport._definition,
  ]);
  expect([
    ...registry.operations.keys(),
  ]).toEqual(
    Object.keys(crashReportOperations).map((name) => `crashReport.${name}`),
  );
  const payloads: Record<string, unknown> = {
    enable: null,
    disable: null,
    list: null,
    remove: {
      id: "a".repeat(32),
    },
  };
  for (const name of Object.keys(payloads)) {
    for (const other of Object.keys(payloads)) {
      expect(
        registry.allowed(
          {
            permissions: [
              `crashReport.${other}`,
            ],
          },
          {
            operation: `crashReport.${name}`,
            payload: payloads[name] as never,
          },
        ),
      ).toBe(name === other);
    }
  }
});
