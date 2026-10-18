import { expect, test } from "bun:test";
import {
  advance,
  INITIAL_UI_PHASE,
  isShutdownCommitted,
  type QuitState,
  type StartState,
  type UiEvent,
  type UiPhase,
} from "#native/windows/bun/ui-phase";

const STARTS: StartState[] = [
  "booting",
  "starting",
  "running",
];
const QUITS: QuitState[] = [
  "idle",
  "pending",
];
const EVENTS: UiEvent[] = [
  "start",
  "navigate",
  "quit-request",
  "quit-cancelled",
  "commit",
  "stop",
];

/** Every phase the union can express: 3 starts x 2 quit states x (live, committed, 2 stopping). */
function everyPhase(): UiPhase[] {
  const phases: UiPhase[] = [];
  for (const start of STARTS) {
    for (const quit of QUITS) {
      phases.push({
        kind: "live",
        start,
        quit,
      });
      phases.push({
        kind: "committed",
        start,
        quit,
      });
      for (const committed of [
        false,
        true,
      ]) {
        phases.push({
          kind: "stopping",
          start,
          quit,
          committed,
        });
      }
    }
  }
  return phases;
}

function label(phase: UiPhase): string {
  switch (phase.kind) {
    case "live":
      return `live/${phase.start}/${phase.quit}`;
    case "committed":
      return `committed/${phase.start}/${phase.quit}`;
    case "stopping":
      return `stopping/${phase.start}/${phase.quit}/${phase.committed ? "committed" : "uncommitted"}`;
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

/** The labels of the live, committed and both stopping phases for one start and quit state. */
function family(start: StartState, quit: QuitState) {
  return {
    live: `live/${start}/${quit}`,
    committed: `committed/${start}/${quit}`,
    uncommitted: `stopping/${start}/${quit}/uncommitted`,
    stopped: `stopping/${start}/${quit}/committed`,
  };
}

const FAMILIES = STARTS.flatMap((start) =>
  QUITS.map((quit) => ({
    start,
    quit,
    ...family(start, quit),
  })),
);

test("the initial phase is live, booting and without a pending quit", () => {
  expect(INITIAL_UI_PHASE).toEqual({
    kind: "live",
    start: "booting",
    quit: "idle",
  });
  expect(everyPhase()).toHaveLength(24);
});

test("start happens once, from booting, and never while stopping", () => {
  expect(transitions("start")).toEqual(
    new Set(
      FAMILIES.flatMap(
        ({ start, quit, live, committed, uncommitted, stopped }) =>
          start === "booting"
            ? [
                `${live} -> ${family("starting", quit).live}`,
                `${committed} -> ${family("starting", quit).committed}`,
                `${uncommitted} -> !Invalid start`,
                `${stopped} -> !Invalid start`,
              ]
            : [
                `${live} -> !Invalid start`,
                `${committed} -> !Invalid start`,
                `${uncommitted} -> !Invalid start`,
                `${stopped} -> !Invalid start`,
              ],
      ),
    ),
  );
});

test("navigation needs a start, is idempotent and never begins while stopping", () => {
  expect(transitions("navigate")).toEqual(
    new Set(
      FAMILIES.flatMap(
        ({ start, quit, live, committed, uncommitted, stopped }) => [
          ...(start === "booting"
            ? [
                `${live} -> !Invalid navigation`,
                `${committed} -> !Invalid navigation`,
              ]
            : [
                `${live} -> ${family("running", quit).live}`,
                `${committed} -> ${family("running", quit).committed}`,
              ]),
          `${uncommitted} -> !Invalid navigation`,
          `${stopped} -> !Invalid navigation`,
        ],
      ),
    ),
  );
});

test("a quit request is accepted only while live and idle; cancellation clears it in every phase", () => {
  expect(transitions("quit-request")).toEqual(
    new Set(
      FAMILIES.flatMap(
        ({ start, quit, live, committed, uncommitted, stopped }) => [
          quit === "idle"
            ? `${live} -> ${family(start, "pending").live}`
            : `${live} -> !Invalid quit request`,
          `${committed} -> !Invalid quit request`,
          `${uncommitted} -> !Invalid quit request`,
          `${stopped} -> !Invalid quit request`,
        ],
      ),
    ),
  );
  expect(transitions("quit-cancelled")).toEqual(
    new Set(
      FAMILIES.flatMap(({ start, live, committed, uncommitted, stopped }) => {
        const idle = family(start, "idle");
        return [
          `${live} -> ${idle.live}`,
          `${committed} -> ${idle.committed}`,
          `${uncommitted} -> ${idle.uncommitted}`,
          `${stopped} -> ${idle.stopped}`,
        ];
      }),
    ),
  );
});

test("commit keeps start progress and the pending quit, and marks a stopping phase committed", () => {
  expect(transitions("commit")).toEqual(
    new Set(
      FAMILIES.flatMap(({ live, committed, uncommitted, stopped }) => [
        `${live} -> ${committed}`,
        `${committed} -> ${committed}`,
        `${uncommitted} -> ${stopped}`,
        `${stopped} -> ${stopped}`,
      ]),
    ),
  );
});

test("stop is absorbing and remembers whether shutdown was committed", () => {
  expect(transitions("stop")).toEqual(
    new Set(
      FAMILIES.flatMap(({ live, committed, uncommitted, stopped }) => [
        `${live} -> ${uncommitted}`,
        `${committed} -> ${stopped}`,
        `${uncommitted} -> ${uncommitted}`,
        `${stopped} -> ${stopped}`,
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
