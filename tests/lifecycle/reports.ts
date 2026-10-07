import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

interface Report {
  page: string;
  results: { name: string; ok: boolean; error?: string }[];
}

export function assertReport(report: Report, requiredChecks: readonly string[] = []) {
  for (const result of report.results)
    assert.equal(result.ok, true, `${report.page}: ${result.name}: ${result.error ?? "failed"}`);
  for (const name of requiredChecks)
    assert.equal(
      report.results.filter((result) => result.name === name).length,
      1,
      `${report.page}: required check missing or duplicated: ${name}`,
    );
}

export async function readReport(path: string): Promise<Report | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Report;
  } catch (error) {
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}
