import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { readNetworkReport } from "./fixtures/macos-network-report.ts";

test("network fixture observes a report created after polling its missing path", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "bunaway-network-report-"));
  try {
    const path = resolve(directory, "report.json");
    expect(await readNetworkReport(path)).toBeUndefined();
    expect(await readNetworkReport(path)).toBeUndefined();
    await Bun.write(path, '{"ok":');
    expect(await readNetworkReport(path)).toBeUndefined();
    await Bun.write(
      path,
      JSON.stringify({
        ok: true,
      }),
    );
    expect(await readNetworkReport(path)).toEqual({
      ok: true,
    });
    // A fresh read must also preserve a later failure rather than cache success.
    await Bun.write(
      path,
      JSON.stringify({
        ok: false,
        message: "fixture failed",
      }),
    );
    expect(await readNetworkReport(path)).toEqual({
      ok: false,
      message: "fixture failed",
    });
  } finally {
    await rm(directory, {
      recursive: true,
      force: true,
    });
  }
});
