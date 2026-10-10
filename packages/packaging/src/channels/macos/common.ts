import assert from "node:assert/strict";
import { lstat, stat, writeFile } from "node:fs/promises";
import { must } from "../../tools.ts";

export type Channel = "mac-direct" | "mac-store";

export function record(value: unknown): Record<string, unknown> {
  assert(
    value && typeof value === "object" && !Array.isArray(value),
    "Expected a property dictionary",
  );
  return value as Record<string, unknown>;
}
export function string(value: unknown, name: string): string {
  assert(typeof value === "string" && value.length > 0, `Missing ${name}`);
  return value;
}
export async function plist(path: string): Promise<Record<string, unknown>> {
  const { stdout } = await must("/usr/bin/plutil", [
    "-convert",
    "json",
    "-o",
    "-",
    path,
  ]);
  return record(JSON.parse(stdout));
}
export async function writePlist(
  path: string,
  value: Record<string, unknown>,
): Promise<void> {
  await writeFile(path, JSON.stringify(value));
  await must("/usr/bin/plutil", [
    "-convert",
    "xml1",
    path,
  ]);
}
export async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}
export async function directory(path: string): Promise<void> {
  assert((await stat(path)).isDirectory(), `Not an app directory: ${path}`);
}
