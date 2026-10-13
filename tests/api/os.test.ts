import { expect, test } from "bun:test";
import { os, osPlugin } from "@bunaway/plugin-os";
import { NativeRegistry } from "@bunaway/protocol";
import { osOperations } from "#plugins/os/src/contract";
import { assertWindowsRegionCode } from "../fixtures/windows-region-code.ts";

test("OS reads have independent permissions and strict null inputs", () => {
  const registry = new NativeRegistry([
    osPlugin,
  ]);
  expect(Object.keys(os)).toEqual([
    "info",
    "usage",
    "locale",
  ]);
  for (const operation of [
    "info",
    "usage",
    "locale",
  ] as const) {
    expect(osOperations[operation].input.safeParse({}).success).toBe(false);
    expect(osOperations[operation].input.parse(null)).toBeNull();
    const call = {
      operation: `os.${operation}`,
      payload: null,
    };
    expect(
      registry.allowed(
        {
          permissions: [
            call.operation,
          ],
        },
        call,
      ),
    ).toBe(true);
    expect(
      registry.allowed(
        {
          permissions: [
            `os.${operation === "info" ? "locale" : "info"}`,
          ],
        },
        call,
      ),
    ).toBe(false);
    expect(
      registry.allowed(
        {
          permissions: [],
        },
        call,
      ),
    ).toBe(false);
  }
});

test("metadata contracts reject secret-bearing extra fields and invalid locale output", () => {
  expect(
    osOperations.info.output.safeParse({
      platform: "windows",
      type: "Windows_NT",
      release: "10",
      version: "Windows",
      architecture: "x64",
      hostname: "host",
      runtime: {
        name: "bun",
        version: "1.4.2",
        pid: 1,
      },
      env: {},
    }).success,
  ).toBe(false);
  expect(
    osOperations.locale.output.safeParse({
      locale: "ko-KR",
      countryCode: "KR",
      preferredLanguages: [
        "ko-KR",
        "en-US",
      ],
      systemLanguage: "en-US",
    }).success,
  ).toBe(true);
  expect(
    osOperations.locale.output.safeParse({
      locale: "en",
      countryCode: null,
      preferredLanguages: [
        "",
      ],
      systemLanguage: "en-US",
    }).success,
  ).toBe(false);
});

test("native locale assertions accept documented numeric regions and preserve leading zeros", () => {
  for (const countryCode of [
    "US",
    "KR",
    "029",
    "001",
    null,
  ]) {
    const locale = osOperations.locale.output.parse({
      locale: countryCode === "029" ? "en-029" : "en-US",
      countryCode,
      preferredLanguages: [
        "en-US",
      ],
      systemLanguage: "en-US",
    });
    expect(() => assertWindowsRegionCode(locale.countryCode)).not.toThrow();
    expect(locale.countryCode).toBe(countryCode);
  }
  for (const value of [
    "",
    "U",
    "USA",
    "us",
    "29",
    "0029",
    "A29",
    "02A",
    "029\n",
    "😀",
  ]) {
    expect(() => assertWindowsRegionCode(value)).toThrow();
  }
});
