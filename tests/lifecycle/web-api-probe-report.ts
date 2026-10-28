/**
 * The report a WebView2 page builds about the Web APIs it can use, and the expectations the host
 * side compares it with. Pure data and functions, so the comparison runs on Linux as a unit test
 * while the page itself only runs on a Windows runner.
 */

/** What one probe saw: the API worked, the API is absent, or it exists but failed with `detail`. */
export type ProbeStatus = "supported" | "unsupported" | "error";

export type ProbeOutcome = {
  status: ProbeStatus;
  /** Error name, renderer string or other observed fact; never an expectation. */
  detail: string;
};

/** Probes every WebView2 runtime must pass: they need no GPU, device or permission. */
export const REQUIRED_PROBES = [
  "worker",
  "sharedWorker",
  "broadcastChannel",
  "webSocket",
  "rtcPeerConnection",
] as const;

/**
 * Probes that depend on the runner (GPU, camera, network stack, service worker scope). They are
 * recorded as observed and never fail the test, so a runner without that hardware stays green.
 */
export const RECORDED_PROBES = [
  "webgl",
  "webgl2",
  "rtcDataChannelLoopback",
  "serviceWorker",
  "mediaDevices",
  "getUserMedia",
] as const;

export type ProbeName =
  | (typeof REQUIRED_PROBES)[number]
  | (typeof RECORDED_PROBES)[number];

export const PROBE_NAMES: readonly ProbeName[] = [
  ...REQUIRED_PROBES,
  ...RECORDED_PROBES,
];

export type ProbeReport = {
  userAgent: string;
  origin: string;
  probes: Record<ProbeName, ProbeOutcome>;
};

const STATUSES: readonly string[] = [
  "supported",
  "unsupported",
  "error",
];

function isOutcome(value: unknown): value is ProbeOutcome {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const outcome = value as Partial<ProbeOutcome>;
  return (
    typeof outcome.status === "string" &&
    STATUSES.includes(outcome.status) &&
    typeof outcome.detail === "string"
  );
}

/**
 * Lists everything wrong with a report: a malformed shape, a missing or unknown probe, a page
 * that ran on another origin, or a required probe that did not report `supported`. An empty
 * list means the report is acceptable.
 */
export function checkReport(report: unknown, origin: string): string[] {
  if (typeof report !== "object" || report === null) {
    return [
      "report is not an object",
    ];
  }
  const {
    userAgent,
    probes,
    origin: seenOrigin,
  } = report as Partial<ProbeReport>;
  const problems: string[] = [];
  if (typeof userAgent !== "string" || userAgent === "") {
    problems.push("userAgent is missing");
  }
  if (seenOrigin !== origin) {
    problems.push(`page origin ${String(seenOrigin)} is not ${origin}`);
  }
  if (typeof probes !== "object" || probes === null) {
    return [
      ...problems,
      "probes is missing",
    ];
  }
  const entries = probes as Record<string, unknown>;
  for (const name of Object.keys(entries)) {
    if (!PROBE_NAMES.includes(name as ProbeName)) {
      problems.push(`unknown probe ${name}`);
    }
  }
  for (const name of PROBE_NAMES) {
    if (!isOutcome(entries[name])) {
      problems.push(`probe ${name} is missing or malformed`);
    }
  }
  for (const name of REQUIRED_PROBES) {
    const outcome = entries[name];
    if (isOutcome(outcome) && outcome.status !== "supported") {
      problems.push(
        `required probe ${name} was ${outcome.status}: ${outcome.detail}`,
      );
    }
  }
  return problems;
}

/** One line per probe, for the test log and for copying into the documentation table. */
export function formatReport(report: ProbeReport): string {
  return PROBE_NAMES.map((name) => {
    const { status, detail } = report.probes[name];
    return `${name}: ${status}${detail === "" ? "" : ` (${detail})`}`;
  }).join("\n");
}
