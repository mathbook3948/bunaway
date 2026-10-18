/**
 * The UI thread's lifecycle as one value instead of independent flags. `advance` is the only way
 * to change it, so every allowed transition is listed here and tested as a table.
 *
 * Start progress is monotonic: a `start` packet moves `booting` to `starting`, and the first
 * startup navigation moves `starting` to `running`. It is kept through shutdown because window
 * creation and the creation timeout log still ask whether the app had started.
 */
export type StartState = "booting" | "starting" | "running";

export type UiPhase =
  /** Pumping normally; `quit` records a quit request the main thread has not answered. */
  | {
      kind: "live";
      start: StartState;
      quit: "idle" | "pending";
    }
  /**
   * App shutdown is committed, whether this thread reported it (`closing`, `session-end`) or the
   * main thread decided alone (`shutdown-committed`). The pump keeps running until `shutdown`
   * arrives, but no close request, quit request, lifecycle event or visibility change may start.
   */
  | {
      kind: "committed";
      start: StartState;
    }
  /** Leaving the pump loop for cleanup, after a `shutdown` packet or a failure. */
  | {
      kind: "stopping";
      start: StartState;
      committed: boolean;
    };

export type UiEvent =
  | "start"
  | "navigate"
  | "quit-request"
  | "quit-cancelled"
  | "commit"
  | "stop";

export const INITIAL_UI_PHASE: UiPhase = {
  kind: "live",
  start: "booting",
  quit: "idle",
};

/** True once app shutdown is committed, in either the committed or the stopping phase. */
export function isShutdownCommitted(phase: UiPhase): boolean {
  return (
    phase.kind === "committed" || (phase.kind === "stopping" && phase.committed)
  );
}

/**
 * The phase after `event`. Throws for a second `start`, a `start` while stopping, a navigation
 * before `start` or while stopping, and a quit request outside the live idle phase; callers guard
 * those with the predicates above, so a throw is a programming error.
 */
export function advance(phase: UiPhase, event: UiEvent): UiPhase {
  switch (event) {
    case "start":
      if (phase.start !== "booting" || phase.kind === "stopping") {
        throw new Error("Invalid start");
      }
      return {
        ...phase,
        start: "starting",
      };
    case "navigate":
      if (phase.start === "booting" || phase.kind === "stopping") {
        throw new Error("Invalid navigation");
      }
      return {
        ...phase,
        start: "running",
      };
    case "quit-request":
      if (phase.kind !== "live" || phase.quit !== "idle") {
        throw new Error("Invalid quit request");
      }
      return {
        ...phase,
        quit: "pending",
      };
    case "quit-cancelled":
      return phase.kind === "live"
        ? {
            ...phase,
            quit: "idle",
          }
        : phase;
    case "commit":
      if (phase.kind === "stopping") {
        return {
          ...phase,
          committed: true,
        };
      }
      return {
        kind: "committed",
        start: phase.start,
      };
    case "stop":
      return {
        kind: "stopping",
        start: phase.start,
        committed: isShutdownCommitted(phase),
      };
  }
}
