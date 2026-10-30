/**
 * The report a WebView2 page builds about page permission requests, and the judgement the host
 * side applies to it. Pure data and functions, so the judgement runs on Linux as a unit test while
 * the page itself only runs on a Windows runner.
 */

/**
 * What the page saw when it asked: the request was refused (`denied`), succeeded (`granted`),
 * the API does not exist (`unsupported`), ended some other way without a grant (`other`, with the
 * error name in `detail`), or never ended before the deadline (`timeout`, a prompt that hangs).
 */
export type PermissionResult =
  | "denied"
  | "granted"
  | "unsupported"
  | "other"
  | "timeout";

export type PermissionOutcome = {
  result: PermissionResult;
  /** Error name, result string or other observed fact; never an expectation. */
  detail: string;
  /** Milliseconds from the call to its outcome. */
  ms: number;
  /** `permission-request-denied` host log lines that appeared while this request ran. */
  hostDenials: number;
};

/** Every request the page makes without a user gesture, in the order it makes them. */
export const PERMISSION_PROBES = [
  "geolocation",
  "notification",
  "clipboardRead",
  "clipboardWrite",
  "wakeLock",
  "pointerLock",
  "filePicker",
] as const;

export type PermissionProbeName = (typeof PERMISSION_PROBES)[number];

/**
 * Probes whose grant is not the host's to refuse: WebView2 has no permission kind for the screen
 * wake lock and raises no `PermissionRequested` event for it, so Chromium answers on its own. The
 * outcome is still recorded and printed, but a grant is not a failure.
 */
const HOST_UNCONTROLLED_PROBES: readonly PermissionProbeName[] = [
  "wakeLock",
];

export type PermissionReport = {
  userAgent: string;
  origin: string;
  probes: Record<PermissionProbeName, PermissionOutcome>;
  /** `permission-request-denied` lines in the host log once every request has ended. */
  hostDenialTotal: number;
};

const RESULTS: readonly string[] = [
  "denied",
  "granted",
  "unsupported",
  "other",
  "timeout",
];

function isOutcome(value: unknown): value is PermissionOutcome {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const outcome = value as Partial<PermissionOutcome>;
  return (
    typeof outcome.result === "string" &&
    RESULTS.includes(outcome.result) &&
    typeof outcome.detail === "string" &&
    typeof outcome.ms === "number" &&
    typeof outcome.hostDenials === "number"
  );
}

/**
 * Lists everything wrong with a report: a malformed shape, a missing or unknown probe, a page on
 * another origin, a request that was granted (the host must refuse every page permission it is asked about), a
 * request that hung on a prompt, or a host log without any refusal.
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
    hostDenialTotal,
  } = report as Partial<PermissionReport>;
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
    if (!PERMISSION_PROBES.includes(name as PermissionProbeName)) {
      problems.push(`unknown probe ${name}`);
    }
  }
  for (const name of PERMISSION_PROBES) {
    const outcome = entries[name];
    if (!isOutcome(outcome)) {
      problems.push(`probe ${name} is missing or malformed`);
    } else if (
      outcome.result === "granted" &&
      !HOST_UNCONTROLLED_PROBES.includes(name)
    ) {
      problems.push(`${name} was granted: ${outcome.detail}`);
    } else if (outcome.result === "timeout") {
      problems.push(`${name} did not end: ${outcome.detail}`);
    }
  }
  if (typeof hostDenialTotal !== "number" || hostDenialTotal < 1) {
    problems.push("host log has no permission-request-denied line");
  }
  return problems;
}

/** One line per request, for the test log and for copying into the test notes. */
export function formatReport(report: PermissionReport): string {
  const lines = PERMISSION_PROBES.map((name) => {
    const { result, detail, ms, hostDenials } = report.probes[name];
    return `${name}: ${result}${detail === "" ? "" : ` (${detail})`}, ${ms} ms, host denials ${hostDenials}`;
  });
  lines.push(`host denials in total: ${report.hostDenialTotal}`);
  return lines.join("\n");
}
