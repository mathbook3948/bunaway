import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { readReport } from "./reports.ts";

test("host reports remain pending until complete JSON is available", async () => {
  const home = await mkdtemp(resolve(tmpdir(), "bunaway-report-"));
  try {
    const path = resolve(home, "report.json");
    expect(await readReport(path)).toBeNull();
    for (const text of ["", '{"page":"memo","results":[']) {
      await writeFile(path, text);
      expect(await readReport(path)).toBeNull();
    }
    const report = { page: "memo", results: [{ name: "failed check", ok: false }] };
    await writeFile(path, JSON.stringify(report));
    expect(await readReport(path)).toEqual(report);
    await expect(readReport(home)).rejects.toThrow();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
