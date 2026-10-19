import { expect, test } from "bun:test";
import os from "@bunaway/plugin-os";
import { osOperations } from "#plugins/os/src/operations";
import {
  localeTag,
  machines,
  regionOf,
} from "#plugins/os/src/platforms/macos-locale";

test("os registers the same operations for macOS and Windows", () => {
  const platforms = os._definition.nativePlatforms;
  expect(Object.keys(platforms).sort()).toEqual([
    "macos",
    "windows",
  ]);
  expect(platforms.macos?.operations).toEqual(platforms.windows?.operations);
  expect(platforms.macos?.operations).toHaveLength(
    Object.keys(osOperations).length,
  );
});

test("os.info accepts macOS as the platform and still rejects unknown platforms", () => {
  const info = {
    type: "Darwin",
    release: "24.0.0",
    version: "Darwin Kernel Version 24.0.0",
    architecture: "arm64",
    hostname: "host",
    runtime: {
      name: "bun",
      version: "1.4.2",
      pid: 1,
    },
  };
  for (const platform of [
    "macos",
    "windows",
  ]) {
    expect(
      osOperations.info.output.safeParse({
        platform,
        ...info,
      }).success,
    ).toBe(true);
  }
  for (const platform of [
    "darwin",
    "linux",
  ]) {
    expect(
      osOperations.info.output.safeParse({
        platform,
        ...info,
      }).success,
    ).toBe(false);
  }
});

test("Foundation locale identifiers become BCP 47 tags without keywords", () => {
  expect(localeTag("ko_KR")).toBe("ko-KR");
  expect(localeTag("en_US@calendar=gregorian;numbers=latn")).toBe("en-US");
  expect(localeTag("zh_Hans_CN")).toBe("zh-Hans-CN");
  expect(localeTag("en")).toBe("en");
});

test("the region comes from the first two-letter or three-digit subtag after the script", () => {
  expect(regionOf("ko-KR")).toBe("KR");
  expect(regionOf("zh-Hans-CN")).toBe("CN");
  expect(regionOf("es-419")).toBe("419");
  expect(regionOf("en-029")).toBe("029");
  expect(regionOf("en")).toBeNull();
  expect(regionOf("zh-Hans")).toBeNull();
  expect(regionOf("en-us")).toBe("US");
  expect(regionOf("de-1996")).toBeNull();
});

test("a Rosetta process reports x86_64 on an ARM64 host and a native process reports its own machine", () => {
  expect(machines(true, "x64")).toEqual({
    processMachine: 0x8664,
    nativeMachine: 0xaa64,
  });
  expect(machines(false, "arm64")).toEqual({
    processMachine: 0,
    nativeMachine: 0xaa64,
  });
  expect(machines(false, "x64")).toEqual({
    processMachine: 0,
    nativeMachine: 0x8664,
  });
  expect(machines(false, "ia32")).toBeNull();
});
