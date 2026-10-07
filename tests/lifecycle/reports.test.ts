import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { hostOperations } from "../../packages/protocol/src/index.ts";
import { matchesCapabilities } from "../fixtures/desktop/host/web/capabilities.ts";
import { assertReport, readReport } from "./reports.ts";

test("native capability reports require the complete catalog and platform support states", () => {
  for (const platform of ["win32", "darwin"]) {
    const capabilities = Object.keys(hostOperations).map((name) => ({
      name,
      support: name.startsWith("windows.") && platform === "darwin" ? "unsupported" : "supported",
      permission: "not-required",
    }));
    expect(matchesCapabilities(capabilities, platform)).toBe(true);
    expect(matchesCapabilities([...capabilities].reverse(), platform)).toBe(true);
    expect(
      matchesCapabilities(
        capabilities.filter((c) => !c.name.startsWith("windows.")),
        platform,
      ),
    ).toBe(false);
    expect(matchesCapabilities([capabilities[0], ...capabilities.slice(0, -1)], platform)).toBe(
      false,
    );
    expect(
      matchesCapabilities(
        capabilities.map((c) => ({
          ...c,
          support: c.name.startsWith("windows.") ? "experimental" : c.support,
        })),
        platform,
      ),
    ).toBe(false);
    expect(
      matchesCapabilities(
        capabilities.map((c) => ({
          ...c,
          support: c.name.startsWith("windows.")
            ? platform === "win32"
              ? "unsupported"
              : "supported"
            : c.support,
        })),
        platform,
      ),
    ).toBe(false);
  }
});

test("required page checks cannot pass with an empty, partial or failed report", () => {
  const report = { page: "main", results: [{ name: "denied command", ok: true }] };
  expect(() => assertReport(report, ["denied command"])).not.toThrow();
  expect(() => assertReport({ ...report, results: [] }, ["denied command"])).toThrow(
    "required check missing",
  );
  expect(() => assertReport(report, ["denied command", "forged context rejected"])).toThrow(
    "forged context rejected",
  );
  expect(() =>
    assertReport({ ...report, results: [{ name: "denied command", ok: false }] }),
  ).toThrow("main: denied command");
  expect(() =>
    assertReport({ ...report, results: [...report.results, ...report.results] }, [
      "denied command",
    ]),
  ).toThrow("duplicated");
});

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
