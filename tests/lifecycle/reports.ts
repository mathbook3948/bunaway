import { readFile } from "node:fs/promises";

interface Report {
  page: string;
  results: { name: string; ok: boolean; error?: string }[];
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
