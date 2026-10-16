import { expect, test } from "bun:test";
import {
  createSessionMessageHandler,
  decodeSessionEndFlags,
  releaseSessionEndWait,
  SESSION_END_RELEASE_BYTES,
  SESSION_END_WAIT_MS,
} from "#native/windows/bun/session-end";

const WM_QUERYENDSESSION = 0x0011;
const WM_ENDSESSION = 0x0016;
const WM_CLOSE = 0x0010;
const ENDSESSION_CLOSEAPP = 0x1n;
const ENDSESSION_CRITICAL = 0x40000000n;
const ENDSESSION_LOGOFF = 0x80000000n;

/** Records hook calls; `release` decides whether the main thread answers inside `begin`. */
function createHandler(options: { release: boolean; waitMs?: number }) {
  const begun: {
    flags: ReturnType<typeof decodeSessionEndFlags>;
    release: SharedArrayBuffer;
  }[] = [];
  const reports: {
    event: string;
    fields: Record<string, unknown>;
  }[] = [];
  const handle = createSessionMessageHandler({
    begin(flags, release) {
      begun.push({
        flags,
        release,
      });
      if (options.release) {
        releaseSessionEndWait(release);
      }
    },
    report(event, fields) {
      reports.push({
        event,
        fields,
      });
    },
    ...(options.waitMs === undefined
      ? {}
      : {
          waitMs: options.waitMs,
        }),
  });
  return {
    handle,
    begun,
    reports,
  };
}

test("session flags decode from the 32-bit lParam, including a sign-extended value", () => {
  expect(decodeSessionEndFlags(0n)).toEqual({
    logoff: false,
    critical: false,
    closeApp: false,
  });
  expect(decodeSessionEndFlags(ENDSESSION_LOGOFF)).toEqual({
    logoff: true,
    critical: false,
    closeApp: false,
  });
  expect(
    decodeSessionEndFlags(
      ENDSESSION_LOGOFF | ENDSESSION_CRITICAL | ENDSESSION_CLOSEAPP,
    ),
  ).toEqual({
    logoff: true,
    critical: true,
    closeApp: true,
  });
  // A 32-bit DWORD flag word can arrive sign-extended in the 64-bit LPARAM.
  expect(decodeSessionEndFlags(BigInt.asIntN(32, ENDSESSION_LOGOFF))).toEqual({
    logoff: true,
    critical: false,
    closeApp: false,
  });
});

test("the query always answers TRUE without starting shutdown and other messages pass through", () => {
  const { handle, begun, reports } = createHandler({
    release: false,
  });
  expect(handle(WM_QUERYENDSESSION, 0n, ENDSESSION_LOGOFF)).toBe(1n);
  expect(handle(WM_QUERYENDSESSION, 0n, ENDSESSION_CRITICAL)).toBe(1n);
  expect(handle(WM_CLOSE, 0n, 0n)).toBeUndefined();
  expect(begun).toEqual([]);
  expect(reports).toEqual([
    {
      event: "session-query-end",
      fields: {
        logoff: true,
        critical: false,
        closeApp: false,
      },
    },
    {
      event: "session-query-end",
      fields: {
        logoff: false,
        critical: true,
        closeApp: false,
      },
    },
  ]);
});

test("a cancelled session end is reported and the app keeps running", () => {
  const { handle, begun, reports } = createHandler({
    release: true,
  });
  expect(handle(WM_ENDSESSION, 0n, ENDSESSION_LOGOFF)).toBe(0n);
  expect(begun).toEqual([]);
  expect(reports.map((report) => report.event)).toEqual([
    "session-end-cancelled",
  ]);
  // A later confirmed end still starts shutdown, because the cancellation is not final.
  expect(handle(WM_ENDSESSION, 1n, 0n)).toBe(0n);
  expect(begun).toHaveLength(1);
});

test("a confirmed session end starts shutdown once across windows and returns after release", () => {
  const { handle, begun, reports } = createHandler({
    release: true,
  });
  const started = performance.now();
  expect(handle(WM_ENDSESSION, 1n, ENDSESSION_LOGOFF)).toBe(0n);
  // Another HWND and a repeated broadcast reach the same handler.
  expect(handle(WM_ENDSESSION, 1n, ENDSESSION_LOGOFF)).toBe(0n);
  expect(performance.now() - started).toBeLessThan(SESSION_END_WAIT_MS / 2);
  expect(begun).toHaveLength(1);
  expect(begun[0]?.flags.logoff).toBe(true);
  expect(begun[0]?.release.byteLength).toBe(SESSION_END_RELEASE_BYTES);
  const finished = reports.filter(
    (report) => report.event === "session-end-wait-finished",
  );
  expect(finished).toHaveLength(1);
  expect(finished[0]?.fields.timedOut).toBe(false);
});

test("an unanswered session end stops waiting at the limit", () => {
  const waitMs = 60;
  const { handle, reports } = createHandler({
    release: false,
    waitMs,
  });
  const started = performance.now();
  expect(handle(WM_ENDSESSION, 1n, 0n)).toBe(0n);
  expect(performance.now() - started).toBeGreaterThanOrEqual(waitMs - 10);
  expect(
    reports.find((report) => report.event === "session-end-wait-finished")
      ?.fields.timedOut,
  ).toBe(true);
  expect(SESSION_END_WAIT_MS).toBe(4000);
});
