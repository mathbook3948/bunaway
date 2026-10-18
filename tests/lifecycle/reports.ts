import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { isRecord } from "@bunaway/protocol";

interface Report {
  page: string;
  results: {
    name: string;
    ok: boolean;
    error?: string;
  }[];
}

function isReport(value: unknown): value is Report {
  if (!isRecord(value)) {
    return false;
  }
  const report = value;
  return (
    typeof report.page === "string" &&
    Array.isArray(report.results) &&
    report.results.every((result) => {
      if (!isRecord(result)) {
        return false;
      }
      const entry = result;
      return (
        typeof entry.name === "string" &&
        typeof entry.ok === "boolean" &&
        (entry.error === undefined || typeof entry.error === "string")
      );
    })
  );
}

/** Requires every reported check to pass and each named check to appear exactly once. */
export function assertReport(
  report: Report,
  requiredChecks: readonly string[] = [],
) {
  for (const result of report.results) {
    assert.equal(
      result.ok,
      true,
      `${report.page}: ${result.name}: ${result.error ?? "failed"}`,
    );
  }
  for (const name of requiredChecks) {
    assert.equal(
      report.results.filter((result) => result.name === name).length,
      1,
      `${report.page}: required check missing or duplicated: ${name}`,
    );
  }
}

/** Reads a complete report; missing or partial files return null, invalid shapes throw. */
export async function readReport(path: string): Promise<Report | null> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    // Valid JSON can still have the wrong shape, so callers only receive checked report data.
    if (!isReport(value)) {
      throw new Error("Invalid host report");
    }
    return value;
  } catch (error) {
    if (
      error instanceof SyntaxError ||
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
}
