import { expect, test } from "bun:test";
import {
  advance,
  INITIAL_UI_PHASE,
  isShutdownCommitted,
  type StartState,
  type UiEvent,
  type UiPhase,
} from "#native/windows/bun/ui-phase";

const STARTS: StartState[] = [
  "booting",
  "starting",
  "running",
];
const EVENTS: UiEvent[] = [
  "start",
  "navigate",
  "quit-request",
  "quit-cancelled",
  "commit",
  "stop",
];

/** Every phase the union can express: 6 live, 3 committed and 6 stopping. */
function everyPhase(): UiPhase[] {
  const phases: UiPhase[] = [];
  for (const start of STARTS) {
    for (const quit of [
      "idle",
      "pending",
    ] as const) {
      phases.push({
        kind: "live",
        start,
        quit,
      });
    }
    phases.push({
      kind: "committed",
      start,
    });
    for (const committed of [
      false,
      true,
    ]) {
      phases.push({
        kind: "stopping",
        start,
        committed,
      });
    }
  }
  return phases;
}

function label(phase: UiPhase): string {
  switch (phase.kind) {
    case "live":
      return `live/${phase.start}/${phase.quit}`;
    case "committed":
      return `committed/${phase.start}`;
    case "stopping":
      return `stopping/${phase.start}/${phase.committed ? "committed" : "uncommitted"}`;
  }
}

/** The `from -> to` set of one event over every phase, with `!` for a rejected transition. */
function transitions(event: UiEvent): Set<string> {
  return new Set(
    everyPhase().map((phase) => {
      try {
        return `${label(phase)} -> ${label(advance(phase, event))}`;
      } catch (error) {
        return `${label(phase)} -> !${(error as Error).message}`;
      }
    }),
  );
}

test("the initial phase is live, booting and without a pending quit", () => {
  expect(INITIAL_UI_PHASE).toEqual({
    kind: "live",
    start: "booting",
    quit: "idle",
  });
  expect(everyPhase()).toHaveLength(15);
});

test("start happens once, from booting, and never while stopping", () => {
  expect(transitions("start")).toEqual(
    new Set([
      "live/booting/idle -> live/starting/idle",
      "live/booting/pending -> live/starting/pending",
      "committed/booting -> committed/starting",
      "stopping/booting/uncommitted -> !Invalid start",
      "stopping/booting/committed -> !Invalid start",
      ...STARTS.filter((start) => start !== "booting").flatMap((start) => [
        `live/${start}/idle -> !Invalid start`,
        `live/${start}/pending -> !Invalid start`,
        `committed/${start} -> !Invalid start`,
        `stopping/${start}/uncommitted -> !Invalid start`,
        `stopping/${start}/committed -> !Invalid start`,
      ]),
    ]),
  );
});

test("navigation needs a start, is idempotent and never begins while stopping", () => {
  expect(transitions("navigate")).toEqual(
    new Set([
      "live/booting/idle -> !Invalid navigation",
      "live/booting/pending -> !Invalid navigation",
      "committed/booting -> !Invalid navigation",
      ...STARTS.filter((start) => start !== "booting").flatMap((start) => [
        `live/${start}/idle -> live/running/idle`,
        `live/${start}/pending -> live/running/pending`,
        `committed/${start} -> committed/running`,
      ]),
      ...STARTS.flatMap((start) => [
        `stopping/${start}/uncommitted -> !Invalid navigation`,
        `stopping/${start}/committed -> !Invalid navigation`,
      ]),
    ]),
  );
});

test("a quit request is accepted only while live and idle; cancellation only matters while live", () => {
  expect(transitions("quit-request")).toEqual(
    new Set(
      STARTS.flatMap((start) => [
        `live/${start}/idle -> live/${start}/pending`,
        `live/${start}/pending -> !Invalid quit request`,
        `committed/${start} -> !Invalid quit request`,
        `stopping/${start}/uncommitted -> !Invalid quit request`,
        `stopping/${start}/committed -> !Invalid quit request`,
      ]),
    ),
  );
  expect(transitions("quit-cancelled")).toEqual(
    new Set(
      STARTS.flatMap((start) => [
        `live/${start}/idle -> live/${start}/idle`,
        `live/${start}/pending -> live/${start}/idle`,
        `committed/${start} -> committed/${start}`,
        `stopping/${start}/uncommitted -> stopping/${start}/uncommitted`,
        `stopping/${start}/committed -> stopping/${start}/committed`,
      ]),
    ),
  );
});

test("commit drops a pending quit, keeps start progress and marks a stopping phase committed", () => {
  expect(transitions("commit")).toEqual(
    new Set(
      STARTS.flatMap((start) => [
        `live/${start}/idle -> committed/${start}`,
        `live/${start}/pending -> committed/${start}`,
        `committed/${start} -> committed/${start}`,
        `stopping/${start}/uncommitted -> stopping/${start}/committed`,
        `stopping/${start}/committed -> stopping/${start}/committed`,
      ]),
    ),
  );
});

test("stop is absorbing and remembers whether shutdown was committed", () => {
  expect(transitions("stop")).toEqual(
    new Set(
      STARTS.flatMap((start) => [
        `live/${start}/idle -> stopping/${start}/uncommitted`,
        `live/${start}/pending -> stopping/${start}/uncommitted`,
        `committed/${start} -> stopping/${start}/committed`,
        `stopping/${start}/uncommitted -> stopping/${start}/uncommitted`,
        `stopping/${start}/committed -> stopping/${start}/committed`,
      ]),
    ),
  );
  for (const phase of everyPhase()) {
    expect(isShutdownCommitted(advance(phase, "stop"))).toBe(
      isShutdownCommitted(phase),
    );
    for (const event of EVENTS) {
      // No event leaves the stopping phase.
      const stopped = advance(phase, "stop");
      try {
        expect(advance(stopped, event).kind).toBe("stopping");
      } catch (error) {
        expect((error as Error).message).toMatch(/^Invalid /);
      }
    }
  }
});
