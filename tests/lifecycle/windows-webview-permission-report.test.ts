import { expect, test } from "bun:test";
import {
  checkReport,
  formatReport,
  PERMISSION_PROBES,
  type PermissionOutcome,
  type PermissionProbeName,
  type PermissionReport,
} from "./windows-webview-permission-report.ts";

const ORIGIN = "https://app.bunaway.local";

/** A report where every request was denied, with `changes` replacing single outcomes. */
function report(
  changes: Partial<Record<PermissionProbeName, PermissionOutcome>> = {},
  overrides: Partial<PermissionReport> = {},
): PermissionReport {
  const denied: PermissionOutcome = {
    result: "denied",
    detail: "NotAllowedError",
    ms: 12,
    hostDenials: 1,
  };
  const probes = Object.fromEntries(
    PERMISSION_PROBES.map((name) => [
      name,
      denied,
    ]),
  ) as PermissionReport["probes"];
  return {
    userAgent: "Mozilla/5.0 Edg/130",
    origin: ORIGIN,
    probes: {
      ...probes,
      ...changes,
    },
    hostDenialTotal: 3,
    ...overrides,
  };
}

test("a report where every request was denied is acceptable", () => {
  expect(checkReport(report(), ORIGIN)).toEqual([]);
});

test("requests refused without a host event or unsupported stay acceptable", () => {
  const quiet: PermissionOutcome = {
    result: "unsupported",
    detail: "",
    ms: 0,
    hostDenials: 0,
  };
  const other: PermissionOutcome = {
    result: "other",
    detail: "SecurityError",
    ms: 3,
    hostDenials: 0,
  };
  expect(
    checkReport(
      report({
        filePicker: quiet,
        pointerLock: other,
      }),
      ORIGIN,
    ),
  ).toEqual([]);
});

test("a granted request fails the report", () => {
  const granted: PermissionOutcome = {
    result: "granted",
    detail: "position",
    ms: 40,
    hostDenials: 0,
  };
  expect(
    checkReport(
      report({
        geolocation: granted,
      }),
      ORIGIN,
    ),
  ).toEqual([
    "geolocation was granted: position",
  ]);
});

test("a granted wake lock is recorded but does not fail the report", () => {
  const granted: PermissionOutcome = {
    result: "granted",
    detail: "screen",
    ms: 1,
    hostDenials: 0,
  };
  expect(
    checkReport(
      report({
        wakeLock: granted,
      }),
      ORIGIN,
    ),
  ).toEqual([]);
});

test("a request that never ends fails the report", () => {
  const hung: PermissionOutcome = {
    result: "timeout",
    detail: "no answer in 8000 ms",
    ms: 8000,
    hostDenials: 0,
  };
  expect(
    checkReport(
      report({
        filePicker: hung,
      }),
      ORIGIN,
    ),
  ).toEqual([
    "filePicker did not end: no answer in 8000 ms",
  ]);
});

test("a host log without any refusal fails the report", () => {
  expect(
    checkReport(
      report(
        {},
        {
          hostDenialTotal: 0,
        },
      ),
      ORIGIN,
    ),
  ).toEqual([
    "host log has no permission-request-denied line",
  ]);
});

test("another origin, a missing probe and an unknown probe are reported", () => {
  const broken = report(
    {},
    {
      origin: "https://example.com",
    },
  );
  delete (broken.probes as Partial<PermissionReport["probes"]>).wakeLock;
  (broken.probes as Record<string, unknown>).camera = broken.probes.geolocation;
  expect(checkReport(broken, ORIGIN)).toEqual([
    "page origin https://example.com is not https://app.bunaway.local",
    "unknown probe camera",
    "probe wakeLock is missing or malformed",
  ]);
  expect(checkReport("nope", ORIGIN)).toEqual([
    "report is not an object",
  ]);
});

test("the formatted report has one line per request and the total", () => {
  const lines = formatReport(report()).split("\n");
  expect(lines).toHaveLength(PERMISSION_PROBES.length + 1);
  expect(lines[0]).toBe(
    "geolocation: denied (NotAllowedError), 12 ms, host denials 1",
  );
  expect(lines.at(-1)).toBe("host denials in total: 3");
});
