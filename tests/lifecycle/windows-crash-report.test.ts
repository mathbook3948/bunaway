import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import crashReport from "@bunaway/plugin-crash-report/native/windows";
import {
  crashDumpListSchema,
  removeOutputSchema,
} from "#plugins/crash-report/src/contract";
import { deadline, killAfter, waitFor } from "../fixtures/deadlines.ts";

setDefaultTimeout(deadline("nativeFixture"));

const child = resolve(import.meta.dir, "../fixtures/crash-report-child.ts");
const dataRoots: string[] = [];

/** An app data directory below the real local app data directory, the only place Windows accepts. */
function newDataRoot(): string {
  const localAppData = process.env.LOCALAPPDATA;
  assert(localAppData, "LOCALAPPDATA is not set.");
  const root = join(
    localAppData,
    "bunaway",
    `crt-${process.pid}-${dataRoots.length}`,
  );
  dataRoots.push(root);
  return root;
}

function adapterFor(dataRoot: string) {
  const platform = crashReport._definition.nativePlatforms.windows;
  assert(platform);
  const adapter = platform.create({
    dataRoot,
    capabilities: [],
  });
  return {
    run: (operation: string, input: unknown) =>
      adapter.execute(`crashReport.${operation}`, input as never, "backend"),
    dispose: () => adapter.dispose(),
  };
}

async function crashChild(dataRoot: string, mode: string): Promise<number> {
  const process_ = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      child,
      dataRoot,
      mode,
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const timer = killAfter(process_, "childStep");
  try {
    return await process_.exited;
  } finally {
    clearTimeout(timer);
  }
}

test.skipIf(process.platform !== "win32")(
  "enable registers the folder, disable and enable repeat, and the list starts empty",
  async () => {
    const dataRoot = newDataRoot();
    const adapter = adapterFor(dataRoot);
    try {
      await adapter.run("enable", null);
      expect(existsSync(join(dataRoot, "crash-dumps"))).toBe(true);
      await adapter.run("disable", null);
      await adapter.run("enable", null);
      expect(await adapter.run("list", null)).toEqual([]);
      expect(
        removeOutputSchema.parse(
          await adapter.run("remove", {
            id: "0".repeat(32),
          }),
        ),
      ).toEqual({
        removed: false,
      });
    } finally {
      adapter.dispose();
    }
  },
);

test.skipIf(process.platform !== "win32")(
  "a fail-fast exit of an enabled process leaves a dump that list reports and remove deletes",
  async () => {
    const dataRoot = newDataRoot();
    const exitCode = await crashChild(dataRoot, "failfast");
    expect(exitCode).not.toBe(0);
    const adapter = adapterFor(dataRoot);
    try {
      const dumps = await waitFor(
        async () => {
          const list = crashDumpListSchema.parse(
            await adapter.run("list", null),
          );
          return list.length > 0 ? list : undefined;
        },
        {
          deadline: "nativeFixture",
          what: `a crash dump in ${join(dataRoot, "crash-dumps")} (exit code ${exitCode}, files ${JSON.stringify(
            existsSync(join(dataRoot, "crash-dumps"))
              ? readdirSync(join(dataRoot, "crash-dumps"))
              : "no folder",
          )})`,
          intervalMs: 500,
        },
      );
      const [dump] = dumps;
      assert(dump);
      expect(dump.kind).not.toBe("unknown");
      expect(dump.sizeBytes).toBeGreaterThan(0);
      expect(
        await adapter.run("remove", {
          id: dump.id,
        }),
      ).toEqual({
        removed: true,
      });
      expect(await adapter.run("list", null)).toEqual([]);
    } finally {
      adapter.dispose();
    }
  },
);

test.skipIf(process.platform !== "win32")(
  "an access violation in native code is reported with the dump outcome",
  async () => {
    const dataRoot = newDataRoot();
    const exitCode = await crashChild(dataRoot, "access-violation");
    const adapter = adapterFor(dataRoot);
    try {
      // Bun may handle the fault itself; the outcome is logged so the documented coverage matches CI.
      await Bun.sleep(5_000);
      const list = crashDumpListSchema.parse(await adapter.run("list", null));
      console.log(
        `access-violation: exit code ${exitCode}, dumps ${JSON.stringify(list)}`,
      );
      expect(exitCode).not.toBe(0);
    } finally {
      adapter.dispose();
    }
  },
);

afterAll(() => {
  for (const root of dataRoots) {
    rmSync(root, {
      recursive: true,
      force: true,
    });
  }
});
