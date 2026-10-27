import { expect, test } from "bun:test";
import {
  checkReport,
  formatReport,
  PROBE_NAMES,
  type ProbeReport,
  REQUIRED_PROBES,
} from "./web-api-probe-report.ts";

const ORIGIN = "https://app.bunaway.local";

/** A report where every probe worked, with `changes` replacing single outcomes. */
function report(
  changes: Partial<ProbeReport["probes"]> = {},
  origin = ORIGIN,
): ProbeReport {
  const probes = Object.fromEntries(
    PROBE_NAMES.map((name) => [
      name,
      {
        status: "supported",
        detail: "",
      },
    ]),
  ) as ProbeReport["probes"];
  return {
    userAgent: "Mozilla/5.0 Edg/130",
    origin,
    probes: {
      ...probes,
      ...changes,
    },
  };
}

test("a report where every probe worked is acceptable", () => {
  expect(checkReport(report(), ORIGIN)).toEqual([]);
});

test("a runner-dependent probe that failed or is absent does not fail the report", () => {
  const observed = report({
    webgl: {
      status: "unsupported",
      detail: "no context",
    },
    getUserMedia: {
      status: "error",
      detail: "NotFoundError",
    },
    serviceWorker: {
      status: "error",
      detail: "timeout",
    },
  });
  expect(checkReport(observed, ORIGIN)).toEqual([]);
});

test("each required probe that is not supported is named with what the page saw", () => {
  for (const name of REQUIRED_PROBES) {
    const problems = checkReport(
      report({
        [name]: {
          status: "error",
          detail: "SecurityError",
        },
      }),
      ORIGIN,
    );
    expect(problems).toEqual([
      `required probe ${name} was error: SecurityError`,
    ]);
  }
});

test("a page on another origin, a missing probe and an unknown probe are reported", () => {
  const broken = report({}, "https://example.com");
  const probes = broken.probes as Record<string, unknown>;
  delete probes.webgl2;
  probes.extra = {
    status: "supported",
    detail: "",
  };
  expect(checkReport(broken, ORIGIN)).toEqual([
    "page origin https://example.com is not https://app.bunaway.local",
    "unknown probe extra",
    "probe webgl2 is missing or malformed",
  ]);
});

test("shapes that are not reports are rejected without throwing", () => {
  expect(checkReport(null, ORIGIN)).toEqual([
    "report is not an object",
  ]);
  expect(
    checkReport(
      {
        userAgent: "",
        origin: ORIGIN,
      },
      ORIGIN,
    ),
  ).toEqual([
    "userAgent is missing",
    "probes is missing",
  ]);
  const malformed = report();
  (malformed.probes as Record<string, unknown>).worker = {
    status: "maybe",
    detail: 1,
  };
  expect(checkReport(malformed, ORIGIN)).toEqual([
    "probe worker is missing or malformed",
  ]);
});

test("the log has one line per probe with its detail", () => {
  const lines = formatReport(
    report({
      webgl: {
        status: "supported",
        detail: "ANGLE (Microsoft, WARP)",
      },
    }),
  ).split("\n");
  expect(lines).toHaveLength(PROBE_NAMES.length);
  expect(lines).toContain("webgl: supported (ANGLE (Microsoft, WARP))");
  expect(lines).toContain("worker: supported");
});
