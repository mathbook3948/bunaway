import { expect, test } from "bun:test";
import { requiredWindowsTools } from "@bunaway/packaging";
import {
  checkDistributionTools,
  type DistributionToolFinders,
} from "#cli/doctor-distribution";

const missing: DistributionToolFinders = {
  iscc: async () => undefined,
  signtool: async () => undefined,
};
const installed: DistributionToolFinders = {
  iscc: async () => "C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe",
  signtool: async () => "C:\\Kits\\10\\bin\\10.0.1\\x64\\signtool.exe",
};
const signing = {
  thumbprint: "AB".repeat(20),
};

test("an app without Inno channels needs no distribution tools", async () => {
  expect(requiredWindowsTools({})).toEqual([]);
  expect(
    requiredWindowsTools({
      signing,
      channels: {
        "win-store-msix": {},
        "mac-direct": {},
      },
    }),
  ).toEqual([]);
  expect(await checkDistributionTools(undefined, missing)).toEqual([]);
  expect(await checkDistributionTools({}, missing)).toEqual([]);
});

test("an unsigned Inno channel needs only the compiler", () => {
  expect(
    requiredWindowsTools({
      channels: {
        "win-direct": {},
      },
    }),
  ).toEqual([
    {
      tool: "ISCC.exe",
      needs: [
        "win-direct",
      ],
    },
  ]);
});

test("channel signing, top-level signing and offline WebView2 each require signtool", () => {
  const needs = (config: Parameters<typeof requiredWindowsTools>[0]) =>
    requiredWindowsTools(config).find((entry) => entry.tool === "signtool.exe")
      ?.needs;
  expect(
    needs({
      channels: {
        "win-direct": {
          signing,
        },
      },
    }),
  ).toEqual([
    "win-direct signing",
  ]);
  expect(
    needs({
      signing,
      channels: {
        "win-direct": {},
        "win-store-unpackaged": {},
      },
    }),
  ).toEqual([
    "win-direct signing",
    "win-store-unpackaged signing",
  ]);
  expect(
    needs({
      channels: {
        "win-direct": {
          webView2: {
            mode: "offline",
            installers: {
              x64: "webview2.exe",
            },
          },
        },
      },
    }),
  ).toEqual([
    "win-direct webView2 offline",
  ]);
  expect(
    needs({
      channels: {
        "win-direct": {
          webView2: "bootstrap",
        },
      },
    }),
  ).toBeUndefined();
});

test("missing tools fail with the channel that needs them and an install hint", async () => {
  const checks = await checkDistributionTools(
    {
      signing,
      channels: {
        "win-direct": {},
      },
    },
    missing,
  );
  expect(
    checks.map((check) => [
      check.name,
      check.passed,
    ]),
  ).toEqual([
    [
      "distribution/ISCC.exe",
      false,
    ],
    [
      "distribution/signtool.exe",
      false,
    ],
  ]);
  expect(checks[0]?.detail).toContain("needed by win-direct");
  expect(checks[0]?.detail).toContain("Inno Setup 6.3");
  expect(checks[1]?.detail).toContain("needed by win-direct signing");
  expect(checks[1]?.detail).toContain("Windows 10/11 SDK");
});

test("installed tools pass and report their path without reading signing values", async () => {
  const checks = await checkDistributionTools(
    {
      signing: {
        ...signing,
        passwordEnv: "SIGNING_SECRET_VARIABLE",
      },
      channels: {
        "win-direct": {},
      },
    },
    installed,
  );
  expect(checks.every((check) => check.passed)).toBe(true);
  expect(checks[0]?.detail).toContain("ISCC.exe");
  const text = JSON.stringify(checks);
  expect(text).not.toContain("SIGNING_SECRET_VARIABLE");
  expect(text).not.toContain(signing.thumbprint);
});
