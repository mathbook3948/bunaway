import assert from "node:assert/strict";
import { lstat, stat, writeFile } from "node:fs/promises";
import { XMLParser } from "fast-xml-parser";
import { must, run } from "../../tools.ts";

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
/** Validate bundle metadata and read string keys, omitting missing or non-string values without converting unrelated plist types. */
export async function plistStrings(
  path: string,
  keys: string[],
): Promise<Record<string, string>> {
  const parser = new XMLParser({
    parseTagValue: false,
    trimValues: false,
  });
  const { stdout } = await must("/usr/bin/plutil", [
    "-convert",
    "xml1",
    "-o",
    "-",
    path,
  ]);
  const document: unknown = parser.parse(stdout);
  assert(
    Object.hasOwn(record(record(document).plist), "dict"),
    "Expected a property dictionary",
  );
  const values: Record<string, string> = {};
  for (const key of keys) {
    const result = await run("/usr/bin/plutil", [
      "-extract",
      key,
      "xml1",
      "-expect",
      "string",
      "-o",
      "-",
      path,
    ]);
    if (result.code !== 0) {
      assert(
        result.code === 1,
        `Cannot read plist key ${key}: ${result.stderr || result.stdout}`,
      );
      continue;
    }
    const value: unknown = parser.parse(result.stdout);
    const text = record(record(value).plist).string;
    assert(typeof text === "string", `Invalid plist string: ${key}`);
    values[key] = text;
  }
  return values;
}

/** Replace or insert one metadata string while preserving all other plist values and their types. */
export async function setPlistString(
  path: string,
  key: string,
  value: string,
): Promise<void> {
  await must("/usr/bin/plutil", [
    "-replace",
    key,
    "-string",
    value,
    path,
  ]);
}

/** Read the framework's JSON-compatible entitlement dictionaries. */
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
